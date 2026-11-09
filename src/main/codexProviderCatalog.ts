/** Metadata for the pinned Qwen runtime; the OpenAI runtime keeps its own catalog. */
export function buildQwenModelCatalog(model: string): Record<string, unknown> {
  return { models: [{
    slug: model,
    display_name: model,
    description: 'Qwen via the XiuPlay Responses adapter',
    default_reasoning_level: null,
    supported_reasoning_levels: [],
    shell_type: 'unified_exec',
    visibility: 'list',
    supported_in_api: true,
    priority: 0,
    availability_nux: null,
    upgrade: null,
    base_instructions: 'You are an agent in XiuPlay.ai. Follow your assigned Planner, Implementer, or Reviewer role, workspace instructions, and sandbox permissions. Planner and Reviewer only inspect and report; they never edit or generate media. Only the Implementer may write files or generate assets. When writing is allowed, use apply_patch for text edits and verify the actual files and runtime. Call only tools declared in the current request. Do not report intended actions as completed work. Report blockers truthfully.',
    include_skills_usage_instructions: true,
    include_plugin_usage_instructions: true,
    supports_reasoning_summary_parameter: false,
    support_verbosity: false,
    default_verbosity: null,
    // Unknown model slugs otherwise receive no native patch tool. The shim
    // maps this freeform tool to a single-string Chat function and back.
    apply_patch_tool_type: 'freeform',
    truncation_policy: { mode: 'tokens', limit: 10_000 },
    context_window: 64_000,
    experimental_supported_tools: [],
    input_modalities: ['text'],
    supports_search_tool: false,
  }] };
}
