# Salvium Fork Mechanics

This pool implementation includes support for Salvium's unique height-triggered hard fork mechanics. These features are strictly opt-in and maintain 100% backward compatibility with existing coins.

## Configuration

To enable Salvium fork mechanics, add the following to your `config.json`:

```json
{
  "coin": "Salvium",
  "symbol": "SAL",
  "salvium": {
    "enabled": true,
    "addressSeparator": "+",
    "heights": {
      "audit_phase1": 815,
      "audit_phase2": 900,
      "audit_phase3": 950,
      "audit_complete": 1000,
      "require_dual_login": 1050,
      "carrot": 1100
    },
    "addressPrefixes": {
      "cryptonote": {
        "public": "0x3ef318",
        "integrated": "0x55ef318", 
        "subaddress": "0xf5ef318"
      },
      "carrot": {
        "public": "0x180c96",
        "integrated": "0x2ccc96",
        "subaddress": "0x314c96"
      }
    },
    "carrotPoolAddress": "SC1...",
    "carrotDonationAddress": "SC1..."
  }
}
```

## Fork Mechanics by Height

### Phase 1: Symbol Transition (Height 815)
- Pool recognizes ticker change from "SAL" to "SAL1"
- Update config `symbol` field accordingly

### Phase 2: Payout Blackout (Heights 815-999)
- Miner shares continue to be accepted and credited
- **Payment processor is disabled** - no payout transactions are sent
- Balances accumulate normally

### Phase 3: Payout Resume (Heights 1000-1049)
- Normal payment processing resumes
- Accumulated balances from blackout period are paid out

### Phase 4: Dual Address Required (Heights 1050-1099)
- Miners **must** provide dual address format: `[cryptonote_address]+[carrot_address]`
- Pool rejects single address logins with clear error message
- Payouts still sent to cryptonote address

### Phase 5: Carrot Payouts (Heights 1100+)
- All payouts switch permanently to carrot addresses
- Pool fees/donations use `carrotPoolAddress` and `carrotDonationAddress`

## Miner Instructions

### Before Height 1050
Use standard cryptonote address:
```
your_cryptonote_address
```

### Heights 1050+
Use dual address format:
```
your_cryptonote_address+your_carrot_address
```

Example:
```
SaLv123...abc+SC1def...xyz
```

## Address Validation

The pool validates addresses against specific Base58 prefixes:

**Cryptonote Addresses:**
- Public: 0x3ef318 (SaLv)
- Integrated: 0x55ef318 (SaLvi)  
- Subaddress: 0xf5ef318 (SaLvs)

**Carrot Addresses:**
- Public: 0x180c96 (SC1)
- Integrated: 0x2ccc96 (SC1i)
- Subaddress: 0x314c96 (SC1s)

## Backward Compatibility

- **Zero impact** on non-Salvium pools
- All logic gated behind `config.salvium.enabled` flag
- Standard cryptonote pools operate unchanged
- No performance impact when disabled

## Implementation Details

The fork mechanics are implemented in:

- `lib/utils.js`: Core Salvium utility functions
- `lib/pool.js`: Dual address login validation  
- `lib/paymentProcessor.js`: Payout blackout and address switching
- `config.json`: Configuration schema and examples

All changes maintain the existing API and behavior for non-Salvium use cases.