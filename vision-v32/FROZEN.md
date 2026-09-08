# Feeding vision V3.2 frozen runtime

The Python modules in `src/` are a byte-for-byte copy of `vision/src/` at Git commit
`b64c790` (`fix: preserve close-up feeding visits`). They are used only by the fine
feeding pass. Sparse screening continues to use the current runtime.

Do not edit thresholds or model behavior in this directory. To change the frozen
algorithm, create a new versioned runtime and validate it against the V3.2 reference
fixtures first.
