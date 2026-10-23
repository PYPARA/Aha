declare module "gltf-validator" {
  export function validateBytes(
    bytes: Uint8Array,
    options?: {
      maxIssues?: number;
      externalResourceFunction?: (uri: string) => Promise<Uint8Array>;
    },
  ): Promise<{
    issues: {
      numErrors: number;
      numWarnings: number;
      messages: { severity: number; message: string }[];
    };
  }>;
}
