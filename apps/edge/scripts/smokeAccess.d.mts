export declare const ACCESS_CLIENT_ID_KEY: 'STAGING_ACCESS_CLIENT_ID';
export declare const ACCESS_CLIENT_SECRET_KEY: 'STAGING_ACCESS_CLIENT_SECRET';
export declare function accessHeaders(
  target: 'staging' | 'production',
  env: Record<string, string | undefined>,
): { headers: Record<string, string>; error?: undefined } | { headers?: undefined; error: string };
export declare function isAccessChallenge(response: { status: number; headers: { get(name: string): string | null } }): boolean;
export declare function accessChallengeMessage(sentToken: boolean): string;
export declare class AccessChallengeError extends Error {}
export declare function smokeRequester(options: {
  origin: string;
  headers: Record<string, string>;
  fetch?: typeof fetch;
}): (path: string, method?: 'GET' | 'HEAD') => Promise<Response>;
export declare function redactHeaderValues(text: string, headers: Record<string, string>): string;
