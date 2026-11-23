import type {
  ConformanceAction,
  ConformanceActionResult,
  MarmotConformanceSubject,
} from "./subject.js";

export interface ConformanceScenario {
  id: string;
  actions: ConformanceAction[];
}

export interface ConformanceScenarioResult {
  scenarioId: string;
  results: ConformanceActionResult[];
  supported: boolean;
}

export async function runConformanceScenario(
  scenario: ConformanceScenario,
  subject: MarmotConformanceSubject,
): Promise<ConformanceScenarioResult> {
  const results: ConformanceActionResult[] = [];
  for (const action of scenario.actions) {
    const result = await subject.execute(action);
    results.push(result);
    if (result.kind === "unsupported") break;
  }
  return {
    scenarioId: scenario.id,
    results,
    supported: results.every((result) => result.kind === "supported"),
  };
}
