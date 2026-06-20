// Read-only startup validation for flag definitions.
// TODO(Phase 2): detect duplicate ids, unknown types/categories, enum mismatches.
window.SDGui = window.SDGui || {};

window.SDGui.validateFlagDefinitions = () => ({ ok: true, warnings: [] });
