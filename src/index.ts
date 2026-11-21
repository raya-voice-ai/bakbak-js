export { Audio, type AudioMetadata, toWav, type WavOptions } from './audio';
export { Bakbak } from './client';
export type { ClientOptions, FetchFn, Logger, RequestOptions } from './core/config';
export {
  APIConnectionError,
  APIError,
  APIStatusError,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  BakbakError,
  type ErrorInit,
  InsufficientCreditsError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  RequestTooLargeError,
  StreamInterruptedError,
  UnprocessableEntityError,
  WebSocketClosedError,
} from './core/errors';
export type { SleepFn } from './core/util';
export type { TTS } from './resources/tts';
export type { Voices } from './resources/voices';
export type { AudioChunk, AudioStream } from './stream';
export { Segmenter, type SegmenterOptions, splitSentences } from './text/segmenter';
export type {
  Container,
  Encoding,
  Language,
  Model,
  OutputFormat,
  SampleRate,
  TTSDefaults,
  TTSParams,
  Voice,
  VoiceFilter,
  VoiceList,
} from './types';
export { VERSION } from './version';
export type {
  ContextEvent,
  ContextOptions,
  ContextSendOptions,
  ContextSendParams,
  SendStreamOptions,
  TTSWebSocket,
  WebSocketContext,
  WebSocketRequest,
  WebSocketRequestResult,
} from './ws/session';
