export interface UpendConfig {
  name: string;
  database?: string;
  dataApi?: string;
  auth?: {
    audience?: string;
    tokenExpiry?: string;
  };
  services?: Record<string, { entry: string; port: number }>;
  deploy?: {
    host?: string;
    dir?: string;
  };
}

export function defineConfig(config: UpendConfig): UpendConfig {
  return config;
}
