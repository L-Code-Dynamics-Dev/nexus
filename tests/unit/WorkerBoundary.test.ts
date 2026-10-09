import { describe, expect, it } from 'vitest';
import worker from '../../workers/api/index.js';
import { withCors } from '../../workers/api/http.js';
import type { Env } from '../../workers/api/types.js';

describe('Worker public boundary', () => {
    it('does not grant browser access when the origin allowlist is missing', () => {
        const response = withCors(new Response('ok'), {}, 'https://attacker.example');

        expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
    });

    it('does not allow wildcard CORS, even when explicitly configured', () => {
        const response = withCors(
            new Response('ok'),
            { ALLOWED_ORIGINS: '*' },
            'https://attacker.example',
        );

        expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
    });

    it('does not allow a serialized null origin through an explicit allowlist', () => {
        const response = withCors(
            new Response('ok'),
            { ALLOWED_ORIGINS: 'https://shop.example' },
            'null',
        );

        expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
    });

    it('allows only an exact configured origin', () => {
        const response = withCors(
            new Response('ok'),
            { ALLOWED_ORIGINS: 'https://shop.example, https://admin.example' },
            'https://shop.example',
        );

        expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://shop.example');
    });

    it('does not expose direct unauthenticated voucher issuance', async () => {
        const env = {
            DB: { prepare: () => { throw new Error('route should not reach D1'); } },
            HMAC_SECRET: 'test-secret',
        } as unknown as Env;
        const response = await worker.fetch(
            new Request('https://nexus.example/api/vouchers/issue', { method: 'POST' }),
            env,
            { waitUntil: () => undefined },
        );

        expect(response.status).toBe(404);
    });
});
