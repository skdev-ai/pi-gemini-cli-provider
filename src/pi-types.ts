/**
 * Type declarations for the 'pi' module and local pi-types.
 * These types are provided by the GSD/Pi runtime and are not available at build time.
 */

/**
 * Pi Context object containing message history.
 */
export interface Context {
  messages: unknown[];
}

/**
 * Pi AssistantMessageEventStream for streaming assistant messages.
 */
export interface AssistantMessageEventStream {
  sendText(text: string): void;
  sendThinking(thinking: string): void;
  sendToolCall(callId: string, name: string, args: unknown): void;
  error(err: Error): void;
  complete(): void;
  onText(listener: (text: string) => void): () => void;
  onThinking(listener: (thinking: string) => void): () => void;
  onToolCall(listener: (callId: string, name: string, args: unknown) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  onComplete(listener: () => void): () => void;
}
