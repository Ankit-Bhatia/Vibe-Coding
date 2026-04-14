/* eslint-disable no-alert */
const STORAGE_KEY = "vc_salesforce_prompt_template_v1";
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128000;
const DEFAULT_RESERVED_OUTPUT_TOKENS = 6000;
const LEGACY_RESERVED_OUTPUT_TOKENS = 4000;

const $ = (id) => document.getElementById(id);

// Standard constraints that are always applied
const STANDARD_CONSTRAINTS = [
  "No hardcoded record IDs, profile IDs, or endpoint URLs. Use metadata, Custom Metadata/Settings, Named Credentials, and labels where appropriate.",
  "Be governor-limit aware and bulk-safe (especially for Apex and record-triggered automation).",
  "Follow Salesforce best practices and the org's established patterns and naming conventions.",
  "Prefer secure-by-default design: least privilege, CRUD/FLS, sharing, input validation, and safe error messages.",
];

function nowIsoDate() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function safe(v) {
  if (v == null) return "";
  const s = String(v).trim();
  return s;
}

function estimateTokens(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return 0;
  return Math.ceil(normalized.length / 4);
}

function formatTokenCount(count) {
  return count.toLocaleString("en-US");
}

function countCharacters(text) {
  return String(text || "").length;
}

function normalizeTokenInput(value, fallback, minimum = 0) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
  return parsed;
}

function getRecommendedReservedOutputTokens(inputs) {
  const artifacts = inputs.artifacts || [];
  let tokens = DEFAULT_RESERVED_OUTPUT_TOKENS;

  if (inputs.workProduct === "Story") tokens += 1000;
  if (inputs.workProduct === "Design") tokens += 500;
  if (inputs.orgMode === "ExistingOrg") tokens += 1000;
  if (artifacts.length > 1) tokens += Math.min(1500, (artifacts.length - 1) * 500);
  if (artifacts.includes("TestClass")) tokens += 500;
  if (artifacts.includes("Object")) tokens += 500;

  return tokens;
}

function getReservedOutputModeFromState(state) {
  if (state && state.reservedOutputTokensAuto === false) return "manual";
  if (state && state.reservedOutputTokensAuto === true) return "auto";

  if (
    state &&
    typeof state.reservedOutputTokens === "number" &&
    state.reservedOutputTokens !== DEFAULT_RESERVED_OUTPUT_TOKENS &&
    state.reservedOutputTokens !== LEGACY_RESERVED_OUTPUT_TOKENS
  ) {
    return "manual";
  }

  return "auto";
}

function syncReservedOutputTokensRecommendation() {
  const input = $("reservedOutputTokens");
  if (!input) return;
  if (input.dataset.mode === "manual" && input.value !== "") return;

  const orgModeRadio = document.querySelector('input[name="orgMode"]:checked');
  const recommended = getRecommendedReservedOutputTokens({
    artifacts: getSelectedArtifacts(),
    workProduct: $("workProduct").value,
    orgMode: orgModeRadio ? orgModeRadio.value : "Greenfield",
  });

  input.dataset.mode = "auto";
  input.value = String(recommended);
}

function getContextBudget(state, promptText) {
  const contextWindowTokens = normalizeTokenInput(
    state.contextWindowTokens,
    DEFAULT_CONTEXT_WINDOW_TOKENS,
    1
  );
  const reservedOutputTokens = normalizeTokenInput(
    state.reservedOutputTokens,
    DEFAULT_RESERVED_OUTPUT_TOKENS,
    0
  );
  const promptTokens = estimateTokens(promptText);
  const availableInputTokens = contextWindowTokens - reservedOutputTokens;

  if (availableInputTokens <= 0) {
    return {
      level: "over",
      promptTokens,
      contextWindowTokens,
      reservedOutputTokens,
      availableInputTokens: 0,
      remainingInputTokens: -promptTokens,
      statusText: "Invalid budget",
      detailText:
        `Reserved response tokens (${formatTokenCount(reservedOutputTokens)}) leave no room for the prompt. ` +
        "Increase the context window or lower the response reserve.",
    };
  }

  const remainingInputTokens = availableInputTokens - promptTokens;
  const usagePct = Math.round((promptTokens / availableInputTokens) * 100);
  const baseDetail =
    `Prompt uses ${formatTokenCount(promptTokens)} of ${formatTokenCount(availableInputTokens)} available input tokens ` +
    `after reserving ${formatTokenCount(reservedOutputTokens)} tokens for the response in a ${formatTokenCount(contextWindowTokens)} token window.`;

  if (remainingInputTokens < 0) {
    return {
      level: "over",
      promptTokens,
      contextWindowTokens,
      reservedOutputTokens,
      availableInputTokens,
      remainingInputTokens,
      statusText: "Exceeds context window",
      detailText:
        `${baseDetail} Reduce prompt size or switch to Optimized. Over by ${formatTokenCount(Math.abs(remainingInputTokens))} tokens.`,
    };
  }

  if (usagePct >= 90) {
    return {
      level: "tight",
      promptTokens,
      contextWindowTokens,
      reservedOutputTokens,
      availableInputTokens,
      remainingInputTokens,
      statusText: "Very tight",
      detailText: `${baseDetail} Only ${formatTokenCount(remainingInputTokens)} input tokens remain.`,
    };
  }

  if (usagePct >= 75) {
    return {
      level: "tight",
      promptTokens,
      contextWindowTokens,
      reservedOutputTokens,
      availableInputTokens,
      remainingInputTokens,
      statusText: "Tight but fits",
      detailText: `${baseDetail} ${formatTokenCount(remainingInputTokens)} input tokens remain.`,
    };
  }

  return {
    level: "healthy",
    promptTokens,
    contextWindowTokens,
    reservedOutputTokens,
    availableInputTokens,
    remainingInputTokens,
    statusText: "Healthy headroom",
    detailText: `${baseDetail} ${formatTokenCount(remainingInputTokens)} input tokens remain.`,
  };
}

function bulletsFromTextarea(text) {
  const raw = safe(text);
  if (!raw) return [];
  return raw
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s?/, "").trim())
    .filter(Boolean);
}

function joinBullets(items) {
  if (!items || items.length === 0) return "- (none provided)";
  return items.map((x) => `- ${x}`).join("\n");
}

function buildArtifactChecklist(artifacts) {
  if (!artifacts || artifacts.length === 0) return [];
  
  const allChecklists = [];
  const seen = new Set();
  
  artifacts.forEach((artifact) => {
    let checklist = [];
    switch (artifact) {
      case "LWC":
        checklist = [
          "Use Lightning Design System patterns; ensure accessibility (ARIA, keyboard navigation).",
          "Prefer Lightning Data Service where appropriate; otherwise call Apex via @wire / imperative calls with clear error states.",
          "Follow LWC best practices: small components, clear public APIs, tracked state, avoid unnecessary rerenders.",
          "Security: enforce CRUD/FLS in Apex, sanitize user input, avoid exposing sensitive fields.",
          "Testing: include Jest tests for UI logic where useful and Apex tests for server-side behavior.",
          "Performance: avoid N+1 call patterns; cache read-only data where appropriate; minimize DOM work.",
        ];
        break;
      case "Apex":
        checklist = [
          "Bulk-safe, governor-limit aware, no SOQL/DML in loops.",
          "CRUD/FLS enforcement and sharing model alignment (with sharing / without sharing justified).",
          "Use service-layer patterns; keep triggers thin (if triggers are involved).",
          "Use Named Credentials for callouts; handle retries/timeouts; surface errors safely.",
          "Use meaningful exceptions, logs (as appropriate), and deterministic behavior.",
          "Provide clear unit test strategy and test data setup.",
        ];
        break;
      case "TestClass":
        checklist = [
          "Deterministic tests with clear arrange/act/assert; assert outcomes, not implementation details.",
          "Use realistic test data; prefer factory methods; avoid SeeAllData unless explicitly required.",
          "Cover success and failure paths; validate exceptions/messages when relevant.",
          "Exercise bulk behavior (200 records) where applicable.",
          "Validate security behavior (sharing, CRUD/FLS) if part of requirements.",
        ];
        break;
      case "Flow":
        checklist = [
          "Choose the right flow type (screen/record-triggered/scheduled/autolaunched) based on requirements.",
          "Use clear naming conventions; document inputs/outputs; avoid hardcoding IDs.",
          "Design for performance: minimize queries/loops; prefer Get Records with selective filters.",
          "Use fault paths; user-friendly error handling; avoid data loss and partial updates.",
          "Use subflows for reuse; keep flows maintainable; include versioning notes.",
        ];
        break;
      case "Object":
        checklist = [
          "Model for reporting, scale, and maintainability; choose lookup vs master-detail intentionally.",
          "Define field types, validation rules, record types, page layouts, and automation boundaries.",
          "Plan security: OWD, role hierarchy effects, sharing rules, permission sets, FLS.",
          "Consider data lifecycle, ownership, audit fields, and integration identifiers.",
          "Avoid redundant automation; define where logic lives (Flow vs Apex) and why.",
        ];
        break;
    }
    
    checklist.forEach((item) => {
      if (!seen.has(item)) {
        seen.add(item);
        allChecklists.push(item);
      }
    });
  });
  
  return allChecklists;
}

function isArtifactSelectionRequired(persona) {
  return safe(persona) !== "Business Analyst";
}

function artifactName(artifact) {
  switch (artifact) {
    case "LWC":
      return "Lightning Web Component (LWC)";
    case "Apex":
      return "Apex";
    case "TestClass":
      return "Apex Test Class";
    case "Flow":
      return "Flow";
    case "Object":
      return "Object / Data Model";
    default:
      return artifact;
  }
}

function artifactNames(artifacts) {
  if (!artifacts || artifacts.length === 0) return "(none selected)";
  return artifacts.map(artifactName).join(", ");
}

function artifactPromptTargetText(artifacts) {
  if (!artifacts || artifacts.length === 0) return "Salesforce work items";
  return artifactNames(artifacts);
}

function artifactContextText(artifacts) {
  if (!artifacts || artifacts.length === 0) return "(not specified)";
  return artifactNames(artifacts);
}

function artifactSummaryText(artifacts) {
  if (!artifacts || artifacts.length === 0) return "No artifact filter";
  return artifactNames(artifacts);
}

function workProductGuidance(workProduct) {
  switch (workProduct) {
    case "Story":
      return {
        outcomes: [
          "A well-formed story with title, narrative, scope, assumptions, acceptance criteria, and out-of-scope items.",
          "A validation checklist (security/perf/governor limits/testing/UX).",
          "Explicit dependencies and questions if information is missing.",
        ],
        outputFormat: [
          "Title",
          "Narrative (As a / I want / So that)",
          "In scope / Out of scope",
          "Acceptance Criteria (bullet list)",
          "Non-functional requirements",
          "Dependencies & Risks",
          "Open Questions",
        ],
      };
    case "Design":
      return {
        outcomes: [
          "A technical design with components, data model, automation boundaries, and integration approach.",
          "Trade-offs, risks, and mitigations.",
          "A build plan with sequencing and test strategy.",
        ],
        outputFormat: [
          "Context & Goals",
          "Assumptions",
          "Proposed Solution (components + responsibilities)",
          "Data Model / Security Model",
          "Automation & Integration",
          "Error Handling / Observability",
          "Testing Strategy",
          "Risks & Alternatives",
          "Implementation Plan",
        ],
      };
    case "Build":
    default:
      return {
        outcomes: [
          "Correct, production-ready implementation artifacts aligned to Salesforce best practices.",
          "Explanation of key decisions and how they meet constraints/guardrails.",
          "A test plan (and tests where applicable).",
        ],
        outputFormat: [
          "Overview",
          "Implementation (code / metadata)",
          "Configuration steps (if any)",
          "Testing (unit + manual)",
          "Notes / Trade-offs",
        ],
      };
  }
}

function orgModeGuidance(orgMode, knownComponents, knownIntegrations, orgComplexity) {
  if (orgMode === "ExistingOrg") {
    const discoveryItems = [];
    if (knownComponents) discoveryItems.push(`Known components: ${knownComponents}`);
    if (knownIntegrations) discoveryItems.push(`Known integrations: ${knownIntegrations}`);
    if (orgComplexity) discoveryItems.push(`Org complexity: ${orgComplexity}`);
    
    return {
      contextAddendum: [
        "This is an existing Salesforce org (Brownfield). Before building anything, you MUST first propose an inventory/analysis plan to understand the current state and avoid duplicating functionality.",
        "You MUST identify existing components that can be reused or extended, and you MUST call out dependencies/impacts.",
        ...(discoveryItems.length > 0 ? [""].concat(discoveryItems) : []),
      ],
      firstStep: [
        "Step 0 (Discovery): list exactly what you need to inspect (objects/fields, flows, LWCs, Apex classes, permission sets, sharing model, managed packages, naming conventions, integrations) and the questions you must answer before implementation.",
        "If any information is missing or ambiguous, first list clarifying questions and assumptions before writing any code.",
        "Only after discovery should you propose the solution and generate code/metadata.",
      ],
    };
  }
  return {
    contextAddendum: [
      "This is a greenfield build for the described scope. You may propose sensible defaults, but you MUST label assumptions and keep them minimal.",
    ],
    firstStep: [
      "Step 0 (Clarifying Questions & Assumptions): if any information is missing or ambiguous, first list clarifying questions and assumptions before writing any code.",
      "Only proceed with clearly stated assumptions after listing what's missing.",
    ],
  };
}

function getPromptMode(value) {
  return safe(value) === "Optimized" ? "Optimized" : "Standard";
}

function isCompressionEnabled(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function buildPromptSections(modelInputs) {
  const persona = safe(modelInputs.persona);
  const artifacts = modelInputs.artifacts || [];
  const workProduct = safe(modelInputs.workProduct);
  const orgMode = safe(modelInputs.orgMode);
  const promptMode = getPromptMode(modelInputs.promptMode);
  const compressionEnabled = isCompressionEnabled(modelInputs.enableCompression);
  const contextWindowTokens = normalizeTokenInput(
    modelInputs.contextWindowTokens,
    DEFAULT_CONTEXT_WINDOW_TOKENS,
    1
  );
  const reservedOutputTokens = normalizeTokenInput(
    modelInputs.reservedOutputTokens,
    DEFAULT_RESERVED_OUTPUT_TOKENS,
    0
  );

  const goal = safe(modelInputs.goal);
  const objects = safe(modelInputs.objects);
  const users = safe(modelInputs.users);
  const requirements = bulletsFromTextarea(modelInputs.requirements);
  const customConstraints = bulletsFromTextarea(modelInputs.constraints);
  const allConstraints = [...STANDARD_CONSTRAINTS, ...customConstraints];
  const existingComponents = safe(modelInputs.existingComponents);
  const knownIntegrations = safe(modelInputs.knownIntegrations);
  const orgComplexity = safe(modelInputs.orgComplexity);
  const orgDetails = safe(modelInputs.orgDetails);
  const integration = safe(modelInputs.integration);
  const outputStyle = safe(modelInputs.outputStyle);

  const artifactChecklist = buildArtifactChecklist(artifacts);
  const work = workProductGuidance(workProduct);
  const org = orgModeGuidance(orgMode, existingComponents, knownIntegrations, orgComplexity);
  const artifactText = artifactPromptTargetText(artifacts);
  const artifactContext = artifactContextText(artifacts);

  const baseGuardrails = [
    "Do NOT invent org-specific names/IDs. If missing, ask questions or state assumptions explicitly.",
    "If requirements conflict, call out the conflict and propose options rather than guessing.",
    "If any information is missing or ambiguous, first list clarifying questions and assumptions before writing any code.",
    "If you cannot safely proceed, output clarifying questions instead of code.",
    "Do not explain the prompt back to me or talk about being an AI. Go straight to the engineering spec.",
    "Output must be copy/paste ready and organized using clear headings and checklists.",
  ];

  const salesforceGuardrails = [
    "Explain how the solution aligns with Salesforce best practices and what trade-offs were made.",
  ];

  const optimizedGuardrails = [
    "Do not invent org-specific names/IDs; ask questions or label assumptions.",
    "If requirements conflict, call it out and present options.",
    "If information is missing or ambiguous, list clarifying questions and assumptions before code.",
    "If you cannot proceed safely, return clarifying questions instead of code.",
    "Skip AI preamble and go straight to the engineering content.",
    "Keep the output copy/paste ready with clear headings and checklists.",
    "Explain Salesforce best-practice alignment and trade-offs.",
    ...artifactChecklist,
  ];

  const outputStyleNote =
    outputStyle === "Jira"
      ? "Format the output to be Jira-ready (concise headings + acceptance criteria)."
      : outputStyle === "Engineering"
        ? "Format the output as an engineering spec with crisp sections and decision logs."
        : "Format the output in Markdown with clear headings and bullet lists.";
  const compressedOutputStyleNote =
    outputStyle === "Jira"
      ? "Jira-ready headings + acceptance criteria."
      : outputStyle === "Engineering"
        ? "Engineering spec with crisp sections."
        : "Markdown headings + bullets.";

  const contextLines = [
    `- Date: ${nowIsoDate()}`,
    `- Artifact type(s): ${artifactContext}`,
    `- Work product: ${workProduct}`,
    `- Org mode: ${orgMode === "ExistingOrg" ? "Existing Org (Brownfield - analyze first)" : "Greenfield (build from scratch)"}`,
    `- Goal: ${goal || "(not provided)"}`,
    `- Primary object(s): ${objects || "(not provided)"}`,
    `- Users/personas: ${users || "(not provided)"}`,
  ];
  const compressedContextLines = [
    `- Date: ${nowIsoDate()}`,
    `- Artifacts: ${artifactContext}`,
    `- Work: ${workProduct}`,
    `- Org: ${orgMode === "ExistingOrg" ? "Existing Org" : "Greenfield"}`,
    `- Goal: ${goal || "(not provided)"}`,
    `- Objects: ${objects || "(not provided)"}`,
    `- Users: ${users || "(not provided)"}`,
  ];

  const existingOrgSection =
    orgMode === "ExistingOrg"
      ? [
          existingComponents ? `### Known components (Apex/Flows/LWCs)\n${existingComponents}` : "",
          knownIntegrations ? `### Known integrations\n${knownIntegrations}` : "",
          orgComplexity ? `### Org complexity notes\n${orgComplexity}` : "",
        ]
          .filter(Boolean)
          .join("\n\n") || "### Existing org context\n(none provided)"
      : "";
  const compressedExistingOrgSection =
    orgMode === "ExistingOrg"
      ? [
          existingComponents ? `Known components\n${existingComponents}` : "",
          knownIntegrations ? `Known integrations\n${knownIntegrations}` : "",
          orgComplexity ? `Org complexity\n${orgComplexity}` : "",
        ]
          .filter(Boolean)
          .join("\n\n") || "Existing org context\n(none provided)"
      : "";

  return {
    promptMode,
    compressionEnabled,
    persona,
    artifacts,
    artifactText,
    workProduct,
    orgMode,
    contextWindowTokens,
    reservedOutputTokens,
    goal,
    objects,
    users,
    requirements,
    allConstraints,
    orgDetails,
    integration,
    work,
    org,
    outputStyleNote,
    compressedOutputStyleNote,
    contextLines,
    compressedContextLines,
    existingOrgSection,
    compressedExistingOrgSection,
    responseBudgetInstruction:
      reservedOutputTokens > 0
        ? `Keep the response within approximately ${formatTokenCount(reservedOutputTokens)} tokens to stay inside the requested context budget.`
        : "",
    compressedResponseBudgetInstruction:
      reservedOutputTokens > 0
        ? `Keep response near ${formatTokenCount(reservedOutputTokens)} tokens.`
        : "",
    standardGuardrails: [...baseGuardrails, ...salesforceGuardrails, ...artifactChecklist],
    optimizedGuardrails,
    finalChecks: [
      "Confirm you met the goal and each requirement.",
      "List any assumptions and open questions.",
      "List security considerations (CRUD/FLS/sharing/PII).",
      "List testing approach (unit + manual).",
      "Add a Confidence Statement rating the output High, Medium, or Low and explain why. If confidence is Low because information is missing, say exactly what input is needed before handoff.",
      "If generating code/metadata, ensure naming is consistent and all referenced fields/objects are defined.",
    ],
  };
}

function buildStandardPrompt(sections) {
  const prompt = [
    `You are a senior Salesforce ${sections.persona} and an expert AI pair-programmer.`,
    "",
    "## Role",
    `Act as a Salesforce ${sections.persona}. Your goal is to help produce a high-quality ${sections.workProduct} for: ${sections.artifactText}.`,
    "",
    "## Context",
    ...sections.contextLines,
    "",
    "### Requirements",
    joinBullets(sections.requirements),
    "",
    sections.orgDetails ? "### Org details\n" + sections.orgDetails : "",
    sections.integration ? "### Data / integration\n" + sections.integration : "",
    sections.existingOrgSection,
    "",
    "## Constraints",
    joinBullets(sections.allConstraints),
    "",
    "## Guardrails",
    joinBullets(sections.standardGuardrails),
    "",
    "## Outcomes (definition of done)",
    joinBullets(sections.work.outcomes),
    "",
    "## Process",
    joinBullets(sections.org.firstStep),
    "",
    "## Output format",
    `- ${sections.outputStyleNote}`,
    sections.responseBudgetInstruction ? `- ${sections.responseBudgetInstruction}` : "",
    "- Use exactly the following section headings in this order:",
    ...sections.work.outputFormat.map((x, i) => `  ${i + 1}. ${x}`),
    "",
    "## Required final checks",
    joinBullets(sections.finalChecks),
  ]
    .filter((x) => x !== "")
    .join("\n");

  return prompt.trim() + "\n";
}

function buildOptimizedPrompt(sections) {
  const optimizedExistingOrgSection = sections.existingOrgSection.replace(/### /g, "");

  const prompt = [
    `Act as a senior Salesforce ${sections.persona}. Produce a ${sections.workProduct} for ${sections.artifactText}.`,
    "",
    "Context",
    ...sections.contextLines,
    "",
    "Requirements",
    joinBullets(sections.requirements),
    "",
    sections.orgDetails ? "Org details\n" + sections.orgDetails : "",
    sections.integration ? "Data / integration\n" + sections.integration : "",
    optimizedExistingOrgSection,
    "",
    "Constraints",
    joinBullets(sections.allConstraints),
    "",
    "Guardrails",
    joinBullets(sections.optimizedGuardrails),
    "",
    "Definition of done",
    joinBullets(sections.work.outcomes),
    "",
    "Process",
    joinBullets(sections.org.firstStep),
    "",
    "Output",
    `- ${sections.outputStyleNote}`,
    sections.responseBudgetInstruction ? `- ${sections.responseBudgetInstruction}` : "",
    `- Use these sections, in order: ${sections.work.outputFormat.join(" | ")}`,
    "- Keep the response concise, implementation-ready, and copy/paste ready.",
    "",
    "Final checks",
    joinBullets(sections.finalChecks),
  ]
    .filter((x) => x !== "")
    .join("\n");

  return prompt.trim() + "\n";
}

function buildCompressedPrompt(sections, baseMode) {
  const guardrails = baseMode === "Optimized" ? sections.optimizedGuardrails : sections.standardGuardrails;
  const prompt = [
    `Act as senior Salesforce ${sections.persona}. Deliver ${sections.workProduct} for ${sections.artifactText}.`,
    "",
    "Context",
    ...sections.compressedContextLines,
    "",
    "Requirements",
    joinBullets(sections.requirements),
    "",
    sections.orgDetails ? "Org details\n" + sections.orgDetails : "",
    sections.integration ? "Integrations\n" + sections.integration : "",
    sections.compressedExistingOrgSection,
    "",
    "Constraints",
    joinBullets(sections.allConstraints),
    "",
    "Guardrails",
    joinBullets(guardrails),
    "",
    "DoD",
    joinBullets(sections.work.outcomes),
    "",
    "Process",
    joinBullets(sections.org.firstStep),
    "",
    "Output",
    `- ${sections.compressedOutputStyleNote}`,
    sections.compressedResponseBudgetInstruction ? `- ${sections.compressedResponseBudgetInstruction}` : "",
    `- Sections: ${sections.work.outputFormat.join(" | ")}`,
    "",
    "Checks",
    joinBullets(sections.finalChecks),
  ]
    .filter((x) => x !== "")
    .join("\n");

  return prompt.trim() + "\n";
}

function buildPromptVariants(modelInputs) {
  const sections = buildPromptSections(modelInputs);
  return {
    promptMode: sections.promptMode,
    compressionEnabled: sections.compressionEnabled,
    standard: buildStandardPrompt(sections),
    optimized: buildOptimizedPrompt(sections),
    standardCompressed: buildCompressedPrompt(sections, "Standard"),
    optimizedCompressed: buildCompressedPrompt(sections, "Optimized"),
  };
}

function buildPrompt(modelInputs) {
  const variants = buildPromptVariants(modelInputs);
  const basePrompt = variants.promptMode === "Optimized" ? variants.optimized : variants.standard;
  if (!variants.compressionEnabled) return basePrompt;
  return variants.promptMode === "Optimized" ? variants.optimizedCompressed : variants.standardCompressed;
}

function getSelectedArtifacts() {
  const persona = $("persona") ? $("persona").value : "";
  const checkboxes = document.querySelectorAll('#artifactGroup input[type="checkbox"]:checked');
  const selected = Array.from(checkboxes).map((cb) => cb.value);
  if (!isArtifactSelectionRequired(persona)) {
    return selected;
  }

  // Ensure at least one is selected for roles that require an artifact
  if (selected.length === 0) {
    const firstCheckbox = document.querySelector('#artifactGroup input[type="checkbox"]');
    if (firstCheckbox) {
      firstCheckbox.checked = true;
      return [firstCheckbox.value];
    }
  }
  return selected;
}

function readStateFromUI() {
  const orgModeRadio = document.querySelector('input[name="orgMode"]:checked');
  return {
    persona: $("persona").value,
    artifacts: getSelectedArtifacts(),
    workProduct: $("workProduct").value,
    orgMode: orgModeRadio ? orgModeRadio.value : "Greenfield",
    goal: $("goal").value,
    objects: $("objects").value,
    users: $("users").value,
    requirements: $("requirements").value,
    existingComponents: $("existingComponents").value,
    knownIntegrations: $("knownIntegrations") ? $("knownIntegrations").value : "",
    orgComplexity: $("orgComplexity") ? $("orgComplexity").value : "",
    constraints: $("constraints").value,
    outputStyle: $("outputStyle").value,
    promptMode: $("promptMode").value,
    enableCompression: $("enableCompression").checked,
    reservedOutputTokensAuto: $("reservedOutputTokens").dataset.mode !== "manual",
    contextWindowTokens: normalizeTokenInput(
      $("contextWindowTokens").value,
      DEFAULT_CONTEXT_WINDOW_TOKENS,
      1
    ),
    reservedOutputTokens: normalizeTokenInput(
      $("reservedOutputTokens").value,
      DEFAULT_RESERVED_OUTPUT_TOKENS,
      0
    ),
    orgDetails: $("orgDetails").value,
    integration: $("integration").value,
  };
}

function writeStateToUI(state) {
  const s = state || {};
  const reservedOutputMode = getReservedOutputModeFromState(s);
  $("persona").value = s.persona || "Developer";
  
  // Handle artifacts - support both old single select format and new multiselect
  const artifacts = s.artifacts || (s.artifact ? [s.artifact] : ["LWC"]);
  document.querySelectorAll('#artifactGroup input[type="checkbox"]').forEach((cb) => {
    cb.checked = artifacts.includes(cb.value);
  });
  
  $("workProduct").value = s.workProduct || "Build";
  
  // Handle org mode - support both old select and new radio buttons
  const orgMode = s.orgMode || "Greenfield";
  const orgModeRadio = document.querySelector(`input[name="orgMode"][value="${orgMode}"]`);
  if (orgModeRadio) {
    orgModeRadio.checked = true;
  }
  
  $("goal").value = s.goal || "";
  $("objects").value = s.objects || "";
  $("users").value = s.users || "";
  $("requirements").value = s.requirements || "";
  $("existingComponents").value = s.existingComponents || "";
  if ($("knownIntegrations")) $("knownIntegrations").value = s.knownIntegrations || "";
  if ($("orgComplexity")) $("orgComplexity").value = s.orgComplexity || "";
  $("constraints").value = s.constraints || "";
  $("outputStyle").value = s.outputStyle || "Markdown";
  $("promptMode").value = getPromptMode(s.promptMode);
  $("enableCompression").checked = isCompressionEnabled(s.enableCompression);
  $("reservedOutputTokens").dataset.mode = reservedOutputMode;
  $("contextWindowTokens").value = normalizeTokenInput(
    s.contextWindowTokens,
    DEFAULT_CONTEXT_WINDOW_TOKENS,
    1
  );
  $("reservedOutputTokens").value = normalizeTokenInput(
    s.reservedOutputTokens,
    DEFAULT_RESERVED_OUTPUT_TOKENS,
    0
  );
  $("orgDetails").value = s.orgDetails || "";
  $("integration").value = s.integration || "";
}

function updateExistingOrgVisibility() {
  const orgModeRadio = document.querySelector('input[name="orgMode"]:checked');
  const isExisting = orgModeRadio && orgModeRadio.value === "ExistingOrg";
  if ($("existingOrgFields")) {
    $("existingOrgFields").hidden = !isExisting;
  }
}

function updateArtifactGuidance() {
  const persona = $("persona").value;
  if ($("artifactHint")) {
    $("artifactHint").textContent = isArtifactSelectionRequired(persona)
      ? "Required for Developer and Architect prompts."
      : "Optional for Business Analyst prompts. Leave blank for a general story-level brief.";
  }
}

function renderReadonlyConstraints() {
  const container = $("readonlyConstraints");
  container.innerHTML = STANDARD_CONSTRAINTS.map(
    (constraint) => `<div class="constraints-readonly__item">${constraint}</div>`
  ).join("");
}

function updatePromptMeta(state) {
  const artifactText = artifactSummaryText(state.artifacts);
  const orgModeText = state.orgMode === "ExistingOrg" ? "Brownfield" : "Greenfield";
  const promptMode = getPromptMode(state.promptMode);
  const compressionEnabled = isCompressionEnabled(state.enableCompression);
  const meta = `${state.persona} • ${artifactText} • ${orgModeText} • ${state.workProduct} • ${promptMode}${compressionEnabled ? " • Compressed" : ""}`;
  $("promptMeta").textContent = meta;

  const outputText = $("output").value;
  const tokenCount = estimateTokens(outputText);
  const charCount = countCharacters(outputText);
  const variants = buildPromptVariants(state);
  let tokenMetaText = `Approx size: ${formatTokenCount(tokenCount)} tokens • ${formatTokenCount(charCount)} chars`;
  const savingsNotes = [];

  if (promptMode === "Optimized") {
    const optimizationBaseline = compressionEnabled ? variants.standardCompressed : variants.standard;
    const baselineCount = estimateTokens(optimizationBaseline);
    const saved = baselineCount - tokenCount;
    if (baselineCount > 0 && saved > 0) {
      const savingsPct = Math.round((saved / baselineCount) * 100);
      savingsNotes.push(`${savingsPct}% less via optimized mode`);
    }
  }

  if (compressionEnabled) {
    const compressionBaseline = promptMode === "Optimized" ? variants.optimized : variants.standard;
    const baselineCount = estimateTokens(compressionBaseline);
    const saved = baselineCount - tokenCount;
    if (baselineCount > 0 && saved > 0) {
      const savingsPct = Math.round((saved / baselineCount) * 100);
      savingsNotes.push(`${savingsPct}% less via compression`);
    }
  }

  if (savingsNotes.length > 0) {
    tokenMetaText = `${tokenMetaText} (${savingsNotes.join("; ")})`;
  }

  $("tokenMeta").textContent = tokenMetaText;

  const budget = getContextBudget(state, $("output").value);
  $("contextBudget").dataset.state = budget.level;
  $("contextStatus").textContent = budget.statusText;
  $("contextDetail").textContent = budget.detailText;

  const recommendedReserve = getRecommendedReservedOutputTokens(state);
  const reserveMode = state.reservedOutputTokensAuto ? "auto" : "manual";
  $("reservedOutputHint").textContent =
    reserveMode === "auto"
      ? `Recommended reserve: ${formatTokenCount(recommendedReserve)} tokens based on artifact complexity.`
      : `Custom reserve: ${formatTokenCount(state.reservedOutputTokens)} tokens. Recommended: ${formatTokenCount(recommendedReserve)}. Clear the field to return to auto.`;
}

function updatePrompt() {
  updateExistingOrgVisibility();
  updateArtifactGuidance();
  syncReservedOutputTokensRecommendation();
  const state = readStateFromUI();
  $("output").value = buildPrompt(state);
  updatePromptMeta(state);

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

function buildCopyPayload(target) {
  const prompt = String($("output").value || "").trim();
  if (!prompt) return "";

  if (target === "claude") {
    return [
      "Use the following prompt as the full task brief.",
      "If any required information is missing, ask concise clarifying questions before answering.",
      "",
      prompt,
    ].join("\n");
  }

  return [
    "Use the following prompt for this task in the current workspace.",
    "Inspect the relevant files first, match existing patterns, and keep edits scoped.",
    "If critical information is missing, ask concise clarifying questions before making changes.",
    "",
    prompt,
  ].join("\n");
}

async function copyPromptFor(target) {
  const text = buildCopyPayload(target);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const temp = document.createElement("textarea");
    temp.value = text;
    temp.setAttribute("readonly", "readonly");
    temp.style.position = "fixed";
    temp.style.opacity = "0";
    document.body.appendChild(temp);
    temp.focus();
    temp.select();
    document.execCommand("copy");
    temp.remove();
  }
}

function downloadPrompt() {
  const state = readStateFromUI();
  const artifactPart = state.artifacts && state.artifacts.length > 0
    ? state.artifacts.join("-").toLowerCase()
    : "none";
  const promptMode = getPromptMode(state.promptMode);
  const nameParts = [
    "prompt",
    artifactPart,
    state.orgMode === "ExistingOrg" ? "existing-org" : "greenfield",
    state.workProduct.toLowerCase(),
  ];
  if (promptMode === "Optimized") {
    nameParts.push("optimized");
  }
  if (isCompressionEnabled(state.enableCompression)) {
    nameParts.push("compressed");
  }
  const filename = `${nameParts.join("_")}.md`;
  const blob = new Blob([$("output").value || ""], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function resetAll() {
  localStorage.removeItem(STORAGE_KEY);
  writeStateToUI({
    persona: "Developer",
    artifacts: ["LWC"],
    workProduct: "Build",
    orgMode: "Greenfield",
    goal: "",
    objects: "",
    users: "",
    requirements: "",
    existingComponents: "",
    knownIntegrations: "",
    orgComplexity: "",
    constraints: "",
    outputStyle: "Markdown",
    promptMode: "Standard",
    enableCompression: false,
    reservedOutputTokensAuto: true,
    contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
    reservedOutputTokens: DEFAULT_RESERVED_OUTPUT_TOKENS,
    orgDetails: "",
    integration: "",
  });
  updatePrompt();
}

function toggleHelpModal() {
  const modal = $("helpModal");
  modal.hidden = !modal.hidden;
  if (!modal.hidden) {
    document.body.style.overflow = "hidden";
  } else {
    document.body.style.overflow = "";
  }
}

function init() {
  renderReadonlyConstraints();
  
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    saved = null;
  }
  if (saved) writeStateToUI(saved);
  updatePrompt();

  const inputs = [
    "persona",
    "workProduct",
    "goal",
    "objects",
    "users",
    "requirements",
    "existingComponents",
    "knownIntegrations",
    "orgComplexity",
    "constraints",
    "outputStyle",
    "promptMode",
    "enableCompression",
    "contextWindowTokens",
    "orgDetails",
    "integration",
  ];
  for (const id of inputs) {
    const el = $(id);
    if (el) {
      el.addEventListener("input", updatePrompt);
      el.addEventListener("change", updatePrompt);
    }
  }

  // Handle artifact checkboxes
  document.querySelectorAll('#artifactGroup input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", updatePrompt);
  });

  // Handle org mode radio buttons
  document.querySelectorAll('input[name="orgMode"]').forEach((radio) => {
    radio.addEventListener("change", updatePrompt);
  });

  $("reservedOutputTokens").addEventListener("input", () => {
    $("reservedOutputTokens").dataset.mode = $("reservedOutputTokens").value === "" ? "auto" : "manual";
    updatePrompt();
  });
  $("reservedOutputTokens").addEventListener("change", () => {
    $("reservedOutputTokens").dataset.mode = $("reservedOutputTokens").value === "" ? "auto" : "manual";
    updatePrompt();
  });

  $("btnCopyClaude").addEventListener("click", () => copyPromptFor("claude"));
  $("btnCopyClaude2").addEventListener("click", () => copyPromptFor("claude"));
  $("btnCopyCursor").addEventListener("click", () => copyPromptFor("cursor"));
  $("btnCopyCursor2").addEventListener("click", () => copyPromptFor("cursor"));
  $("btnDownload").addEventListener("click", downloadPrompt);
  $("btnReset").addEventListener("click", resetAll);
  $("btnHelp").addEventListener("click", toggleHelpModal);
  $("btnCloseHelp").addEventListener("click", toggleHelpModal);
  $("output").addEventListener("input", () => {
    updatePromptMeta(readStateFromUI());
  });
  
  // Close modal when clicking overlay
  $("helpModal").addEventListener("click", (e) => {
    if (e.target.classList.contains("modal__overlay")) {
      toggleHelpModal();
    }
  });
  
  // Close modal with Escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("helpModal").hidden) {
      toggleHelpModal();
    }
  });
}

document.addEventListener("DOMContentLoaded", init);
