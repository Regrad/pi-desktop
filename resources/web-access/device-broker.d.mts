export interface DeviceInfo { id: string; name: string; cwd: string; drives: string[]; connected: boolean }
export interface DeviceBroker {
  info(id: string): DeviceInfo | undefined;
  invoke(id: string, operation: string, args?: Record<string, unknown>, options?: { signal?: AbortSignal; timeout?: number }): Promise<any>;
}
