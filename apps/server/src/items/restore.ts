/**
 * 产品 JSON 恢复 (NEX-06). The format and the planner moved to @nexus/shared (v0.5 · UI 焕新 U1) so
 * that the browser's local collection restores a backup with exactly these rules; the server keeps
 * importing them from here.
 */
export { COLLECTION_FORMAT, COLLECTION_VERSION, CollectionFileSchema, planRestore, restoreSummary as summary, type CollectionFile, type DuplicatePolicy, type PlannedItem, type RestoreBasis, type RestorePlan, type RestoreSummary } from '@nexus/shared';
