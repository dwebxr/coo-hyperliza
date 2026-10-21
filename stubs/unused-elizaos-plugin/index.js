// @elizaos/cli depends on @elizaos/plugin-openai and @elizaos/plugin-ollama for its plugin registry and
// `elizaos scenario`, but `elizaos start` never loads them. package.json "overrides" points both here so
// their dependency trees (and the advisories in them) are not installed. Coo writes with Claude
// (src/anthropic-models.ts); see src/llm-provider.ts.
export default {
  name: 'unused-elizaos-plugin',
  description: 'Placeholder for an elizaOS plugin this project does not use',
};
