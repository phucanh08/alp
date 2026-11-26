/** The parts of a resolved agent this fake compiles. */
type FakeAgent = {
  name: string, projectRoot: string, instructions: { project?: string, agent?: string },
  skills: unknown, mcp: unknown, runtime: unknown,
};

/** Deterministic compiler for tests and local dry runs. Never launches a process. */
export class FakeAdapter {
  id = 'fake';
  capabilities() {
    return { instructions: 'emulated', skills: 'emulated', hooks: 'unsupported', mcp: 'emulated' };
  }
  async compile(agent: FakeAgent) {
    return {
      adapterId: this.id, agentName: agent.name, projectRoot: agent.projectRoot,
      material: {
        instructions: [agent.instructions.project, agent.instructions.agent].filter(Boolean).join('\n\n'),
        skills: agent.skills, mcp: agent.mcp, runtime: agent.runtime,
      },
    };
  }
}
