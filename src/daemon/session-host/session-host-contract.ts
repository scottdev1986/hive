import type {
  AttachGrant,
  AttachRequest,
  CaptureRequest,
  CaptureResult,
  CreateResult,
  ResizeResult,
  SessionEvent,
  SessionInspection,
  SessionLocator,
  SessionSpec,
  TerminalGeometry,
  TerminationRequest,
  TerminationResult,
} from "../../schemas/session-protocol";

export type {
  AttachGrant,
  AttachRequest,
  CaptureRequest,
  CaptureResult,
  CreateResult,
  ResizeResult,
  SessionEvent,
  SessionInspection,
  SessionLocator,
  SessionSpec,
  SessionSubject,
  TerminalGeometry,
  TerminationRequest,
  TerminationResult,
} from "../../schemas/session-protocol";

export interface SessionHost {
  create(spec: SessionSpec): Promise<CreateResult>;
  inspect(locator: SessionLocator): Promise<SessionInspection>;
  list(instanceId: string): Promise<readonly SessionInspection[]>;
  capture(
    locator: SessionLocator,
    request: CaptureRequest,
  ): Promise<CaptureResult>;
  issueAttach(
    locator: SessionLocator,
    request: AttachRequest,
  ): Promise<AttachGrant>;
  resize(
    locator: SessionLocator,
    geometry: TerminalGeometry,
  ): Promise<ResizeResult>;
  terminate(
    locator: SessionLocator,
    request: TerminationRequest,
  ): Promise<TerminationResult>;
  subscribe(afterEventSeq: string): AsyncIterable<SessionEvent>;
}
