Dev prompt integration for QA JSON:
1) Load and validate QA JSON against `/vibe/schemas/qa_pack.schema.json`.
2) Treat `userStoryNo` as `jiraKey` for all Scenario/Test Case IDs.
3) For each planned component, select linked testCases via `componentRefs`.
4) Each component section in the Dev prompt must include `jiraKey` + at least one `TC-<jiraKey>-###`.
5) If any component has zero mapped TC IDs, stop and request QA refresh.
6) Keep implementation aligned with `testPlan.entryCriteria` and `testPlan.exitCriteria` (DoD-driven).
7) AUTO_APEX unit tests must embed TC IDs in method names or nearby comments.
8) AUTO_JEST unit tests must embed TC IDs in `it()` names or nearby comments.
9) Preserve `covers[]` AC mapping to keep AC->TC traceability intact.
