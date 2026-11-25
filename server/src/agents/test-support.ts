// Shared by tests: a tool host that does nothing.
import type { KestrelToolHost } from './types.ts';

const refuse = async () => ({ text: 'not available in this test', isError: true });
export const NO_TOOLS: KestrelToolHost = {
  listProjects: async () => [], addProject: refuse, handoff: refuse, startReview: async () => ({ text: 'declined' }),
  moveToProject: refuse, delegate: refuse, spawn: refuse, sessionStatus: refuse, askSession: refuse, sendNote: refuse, completeWorkstream: refuse, waitFor: refuse, archiveSession: refuse, showWidget: refuse, sendFile: refuse, nextStep: refuse, postReview: refuse, suggest: refuse, ticketRead: refuse, ticketUpdate: refuse,
  browserNavigate: refuse, browserRead: refuse, browserClick: refuse, browserType: refuse, browserScreenshot: refuse, browserConsole: refuse,
  simList: refuse, simBoot: refuse, simLaunch: refuse, simScreenshot: refuse, simTap: refuse, simSwipe: refuse, simPinch: refuse, simType: refuse, simKey: refuse, simButton: refuse, simOpenUrl: refuse, simAppearance: refuse,
};
