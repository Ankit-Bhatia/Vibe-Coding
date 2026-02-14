Dev prompt integration for QA JSON:
1) Load and validate QA JSON against `/vibe/schemas/qa_pack.schema.json`.
2) For each planned component, select linked testCases via `componentRefs`.
3) Each component section in the Dev prompt must include `jiraKey` + at least one `TC-<jiraKey>-###`.
4) If any component has zero mapped TC IDs, stop and request QA refresh.
5) AUTO_APEX unit tests must embed TC IDs in method names or nearby comments.
6) AUTO_JEST unit tests must embed TC IDs in `it()` names or nearby comments.
7) Preserve `covers[]` AC mapping when generating tests to keep AC->TC traceability intact.
