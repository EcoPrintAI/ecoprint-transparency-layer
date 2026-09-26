/** Optional adapter contract for caller-supplied AI providers. */

export async function explainWithProvider({ facts, insights, provider }) {
    if (!provider) return null;
    if (typeof provider.explain !== 'function') {
        throw new TypeError('AI provider must implement explain({ facts, insights, instruction })');
    }
    const explanation = await provider.explain({
        facts: structuredClone(facts),
        insights: structuredClone(insights),
        instruction: 'Explain only the supplied measured and derived facts. Do not add measurements or assert causality beyond the deterministic insights.',
    });
    if (typeof explanation !== 'string' || explanation.trim().length === 0) {
        throw new TypeError('AI provider must return a non-empty explanation string');
    }
    return explanation.trim();
}
