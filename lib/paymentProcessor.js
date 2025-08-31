/**
 * Cryptonote Node.JS Pool
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Payments processor
 **/

// Load required modules
let fs = require('fs');
let async = require('async');

let apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet, config.api);
let notifications = require('./notifications.js');
let utils = require('./utils.js');

// Initialize log system
let logSystem = 'payments';
require('./exceptionWriter.js')(logSystem);

/**
 * Run payments processor
 **/

log('info', logSystem, 'Started');

if (!config.poolServer.paymentId) config.poolServer.paymentId = {};
if (!config.poolServer.paymentId.addressSeparator) config.poolServer.paymentId.addressSeparator = "+";
if (!config.payments.priority) config.payments.priority = 0;

function runInterval () {
	// Check for Salvium payout blackout
	if (utils.isSalviumEnabled()) {
		apiInterfaces.rpcDaemon('getblockcount', [], function (error, result) {
			if (error) {
				log('error', logSystem, 'Error getting block count for Salvium check: %j', [error]);
				return;
			}
			
			let currentHeight = result.count - 1; // getblockcount returns height + 1
			let salviumState = utils.getSalviumState(currentHeight);
			
			if (salviumState === 'payout_blackout') {
				log('info', logSystem, 'Salvium payout blackout active at height %d. Skipping payment processing.', [currentHeight]);
				return;
			}
			
			// Continue with normal payment processing
			processSalviumAwarePayments(currentHeight);
		});
		return;
	}
	
	// Non-Salvium payment processing
	processSalviumAwarePayments(0);
}

function processSalviumAwarePayments(currentHeight) {
	async.waterfall([

		// Get worker keys
		function (callback) {
			redisClient.keys(config.coin + ':workers:*', function (error, result) {
				if (error) {
					log('error', logSystem, 'Error trying to get worker balances from redis %j', [error]);
					callback(true);
					return;
				}
				callback(null, result);
			});
		},

		// Get worker balances
		function (keys, callback) {
			let redisCommands = keys.map(function (k) {
				return ['hget', k, 'balance'];
			});
			redisClient.multi(redisCommands)
				.exec(function (error, replies) {
					if (error) {
						log('error', logSystem, 'Error with getting balances from redis %j', [error]);
						callback(true);
						return;
					}

					let balances = {};
					for (let i = 0; i < replies.length; i++) {
						let parts = keys[i].split(':');
						let workerId = parts[parts.length - 1];

						balances[workerId] = parseInt(replies[i]) || 0;
					}
					callback(null, keys, balances);
				});
		},

		// Get worker minimum payout
		function (keys, balances, callback) {
			let redisCommands = keys.map(function (k) {
				return ['hget', k, 'minPayoutLevel'];
			});
			redisClient.multi(redisCommands)
				.exec(function (error, replies) {
					if (error) {
						log('error', logSystem, 'Error with getting minimum payout from redis %j', [error]);
						callback(true);
						return;
					}

					let minPayoutLevel = {};
					for (let i = 0; i < replies.length; i++) {
						let parts = keys[i].split(':');
						let workerId = parts[parts.length - 1];

						let minLevel = config.payments.minPayment;
						let maxLevel = config.payments.maxPayment;
						let defaultLevel = minLevel;

						let payoutLevel = parseInt(replies[i]) || minLevel;
						if (payoutLevel < minLevel) payoutLevel = minLevel;
						if (maxLevel && payoutLevel > maxLevel) payoutLevel = maxLevel;
						minPayoutLevel[workerId] = payoutLevel;

						if (payoutLevel !== defaultLevel) {
							log('info', logSystem, 'Using payout level of %s for %s (default: %s)', [utils.getReadableCoins(minPayoutLevel[workerId]), workerId, utils.getReadableCoins(defaultLevel)]);
						}
					}
					callback(null, balances, minPayoutLevel);
				});
		},

		// Filter workers under balance threshold for payment
		function (balances, minPayoutLevel, callback) {
			let payments = {};

			for (let worker in balances) {
				let balance = balances[worker];
				if (balance >= minPayoutLevel[worker]) {
					let remainder = balance % config.payments.denomination;
					let payout = balance - remainder;

					if (config.payments.dynamicTransferFee && config.payments.minerPayFee) {
						payout -= config.payments.transferFee;
					}
					if (payout < 0) continue;

					payments[worker] = payout;
				}
			}

			if (Object.keys(payments)
				.length === 0) {
				log('info', logSystem, 'No workers\' balances reached the minimum payment threshold');
				callback(true);
				return;
			}

			let transferCommands = [];
			let addresses = 0;
			let commandAmount = 0;
			let commandIndex = 0;
			let ringSize = config.payments.ringSize ? config.payments.ringSize : config.payments.mixin;

			for (let worker in payments) {
				let amount = parseInt(payments[worker]);
				if (config.payments.maxTransactionAmount && amount + commandAmount > config.payments.maxTransactionAmount) {
					amount = config.payments.maxTransactionAmount - commandAmount;
				}

				let address = worker;
				let payment_id = null;
				let with_payment_id = false;

				// Handle Salvium dual address and carrot switching
				if (utils.isSalviumEnabled()) {
					let salviumState = utils.getSalviumState(currentHeight);
					
					if (salviumState === 'carrot_payouts') {
						// Switch to carrot address for payouts
						let dualAddress = utils.parseSalviumDualAddress(worker);
						if (dualAddress) {
							address = dualAddress.carrot;
							log('info', logSystem, 'Salvium: Sending payment to carrot address %s', [address]);
						} else {
							// For backwards compatibility, if no dual address, try to parse as single address
							let addr = address.split(config.poolServer.paymentId.addressSeparator);
							address = addr[0];
							payment_id = addr[1] || null;
						}
					} else if (salviumState === 'dual_required') {
						// Still pay to cryptonote address but parse dual format
						let dualAddress = utils.parseSalviumDualAddress(worker);
						if (dualAddress) {
							address = dualAddress.cryptonote;
						} else {
							let addr = address.split(config.poolServer.paymentId.addressSeparator);
							address = addr[0];
							payment_id = addr[1] || null;
						}
					} else {
						// Normal payment processing for other heights
						let addr = address.split(config.poolServer.paymentId.addressSeparator);
						address = addr[0];
						payment_id = addr[1] || null;
					}
				} else {
					// Standard address parsing for non-Salvium coins
					let addr = address.split(config.poolServer.paymentId.addressSeparator);
					address = addr[0];
					payment_id = addr[1] || null;
				}

				// Payment ID validation (existing logic)
				if ((utils.isIntegratedAddress && utils.isIntegratedAddress(address)) || payment_id) {
					with_payment_id = true;
					if (payment_id) {
						payment_id = payment_id.replace(/[^A-Za-z0-9]/g, '');
						if (payment_id.length !== 16 && payment_id.length !== 64) {
							with_payment_id = false;
							payment_id = null;
						}
					}
					if (addresses > 0) {
						commandIndex++;
						addresses = 0;
						commandAmount = 0;
					}
				}

				if (config.poolServer.fixedDiff && config.poolServer.fixedDiff.enabled) {
					let addr = address.split(config.poolServer.fixedDiff.addressSeparator);
					if (addr.length >= 2) address = addr[0];
				}

				if (!transferCommands[commandIndex]) {
					transferCommands[commandIndex] = {
						redis: [],
						amount: 0,
						rpc: {
							destinations: [],
							fee: config.payments.transferFee,
							priority: config.payments.priority,
							unlock_time: 0
						}
					};
					if (config.payments.ringSize)
						transferCommands[commandIndex].rpc.ring_size = ringSize;
					else
						transferCommands[commandIndex].rpc.mixin = ringSize;
				}

				transferCommands[commandIndex].rpc.destinations.push({
					amount: amount,
					address: address
				});
				if (payment_id) transferCommands[commandIndex].rpc.payment_id = payment_id;

				transferCommands[commandIndex].redis.push(['hincrby', config.coin + ':workers:' + worker, 'balance', -amount]);
				if (config.payments.dynamicTransferFee && config.payments.minerPayFee) {
					transferCommands[commandIndex].redis.push(['hincrby', config.coin + ':workers:' + worker, 'balance', -config.payments.transferFee]);
				}
				transferCommands[commandIndex].redis.push(['hincrby', config.coin + ':workers:' + worker, 'paid', amount]);
				transferCommands[commandIndex].amount += amount;

				addresses++;
				commandAmount += amount;

				if (config.payments.dynamicTransferFee) {
					transferCommands[commandIndex].rpc.fee = config.payments.transferFee * addresses;
				}

				if (addresses >= config.payments.maxAddresses || (config.payments.maxTransactionAmount && commandAmount >= config.payments.maxTransactionAmount) || with_payment_id) {
					commandIndex++;
					addresses = 0;
					commandAmount = 0;
				}
			}

			let timeOffset = 0;
			let notify_miners = [];

			let daemonType = config.daemonType ? config.daemonType.toLowerCase() : "default";

			async.filter(transferCommands, function (transferCmd, cback) {
				let rpcCommand = "transfer";
				let rpcRequest = transferCmd.rpc;

				// Handle Salvium asset type settings based on height
				if (utils.isSalviumEnabled()) {
					// Guard against missing structures
					if (transferCmd && transferCmd.rpc) {
						// Compute effective symbol by height
						let transitionHeight = config.salvium && config.salvium.heights && config.salvium.heights.audit_phase1 
							? config.salvium.heights.audit_phase1 
							: 815;
						let effectiveSymbol = (currentHeight >= transitionHeight) ? 'SAL1' : 'SAL';
						
						// Set asset fields for all destinations
						if (transferCmd.rpc.destinations && Array.isArray(transferCmd.rpc.destinations)) {
							transferCmd.rpc.destinations.forEach(destination => {
								destination.asset_type = effectiveSymbol;
							});
						}
						
						// Set source and destination assets
						transferCmd.rpc.source_asset = effectiveSymbol;
						transferCmd.rpc.dest_asset = effectiveSymbol;
						
						// Always set tx_type = 3 for Salvium (both phases)
						transferCmd.rpc.tx_type = 3;
					}
				}


				if (daemonType === "bytecoin") {
					rpcCommand = "sendTransaction";
					rpcRequest = {
						transfers: transferCmd.rpc.destinations,
						fee: transferCmd.rpc.fee,
						anonymity: ringSize,
						unlockTime: transferCmd.rpc.unlock_time
					};
					if (transferCmd.rpc.payment_id) {
						rpcRequest.paymentId = transferCmd.rpc.payment_id;
					}
				}

				apiInterfaces.rpcWallet(rpcCommand, rpcRequest, function (error, result) {
					if (error) {
						log('error', logSystem, 'Error with %s RPC request to wallet daemon %j', [rpcCommand, error]);
						log('error', logSystem, 'Payments failed to send to %j', transferCmd.rpc.destinations);
						cback(false);
						return;
					}

					let now = (timeOffset++) + Date.now() / 1000 | 0;
					let txHash = daemonType === "bytecoin" ? result.transactionHash : result.tx_hash;
					txHash = txHash.replace('<', '')
						.replace('>', '');

					transferCmd.redis.push(['zadd', config.coin + ':payments:all', now, [
						txHash,
						transferCmd.amount,
						transferCmd.rpc.fee,
						ringSize,
						Object.keys(transferCmd.rpc.destinations)
						.length
					].join(':')]);

					let notify_miners_on_success = [];
					for (let i = 0; i < transferCmd.rpc.destinations.length; i++) {
						let destination = transferCmd.rpc.destinations[i];
						if (transferCmd.rpc.payment_id) {
							destination.address += config.poolServer.paymentId.addressSeparator + transferCmd.rpc.payment_id;
						}
						transferCmd.redis.push(['zadd', config.coin + ':payments:' + destination.address, now, [
							txHash,
							destination.amount,
							transferCmd.rpc.fee,
							ringSize
						].join(':')]);

						notify_miners_on_success.push(destination);
					}

					log('info', logSystem, 'Payments sent via wallet daemon %j', [result]);
					redisClient.multi(transferCmd.redis)
						.exec(function (error, replies) {
							if (error) {
								log('error', logSystem, 'Super critical error! Payments sent yet failing to update balance in redis, double payouts likely to happen %j', [error]);
								log('error', logSystem, 'Double payments likely to be sent to %j', transferCmd.rpc.destinations);
								cback(false);
								return;
							}

							for (let m in notify_miners_on_success) {
								notify_miners.push(notify_miners_on_success[m]);
							}

							cback(true);
						});
				});
			}, function (succeeded) {
				let failedAmount = transferCommands.length - succeeded.length;

				for (let m in notify_miners) {
					let notify = notify_miners[m];
					log('info', logSystem, 'Payment of %s to %s', [utils.getReadableCoins(notify.amount), notify.address]);
					notifications.sendToMiner(notify.address, 'payment', {
						'ADDRESS': notify.address.substring(0, 7) + '...' + notify.address.substring(notify.address.length - 7),
						'AMOUNT': utils.getReadableCoins(notify.amount),
					});
				}
				log('info', logSystem, 'Payments splintered and %d successfully sent, %d failed', [succeeded.length, failedAmount]);

				callback(null);
			});

		}

	], function (error, result) {
		setTimeout(runInterval, config.payments.interval * 1000);
	});
}

runInterval();
