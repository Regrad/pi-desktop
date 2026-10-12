export interface WebAccessSettings {
  localEnabled: boolean;
  remoteEnabled: boolean;
  address: string;
  port: number;
  username: string;
  /** Empty preserves the existing password. Never returned to the renderer. */
  password?: string;
  /** Explicitly changes certificate identity; clients must verify it again. */
  renewCertificate?: boolean;
}

export interface WebAccessStatus extends Omit<WebAccessSettings, "password"> {
  passwordConfigured: boolean;
  running: boolean;
  url: string;
  fingerprint: string;
  validTo: string;
  error: string;
  remoteReady: boolean;
}
