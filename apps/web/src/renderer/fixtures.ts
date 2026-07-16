import type { AtlasScene, SceneEntity } from './types';

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const baseEntities: SceneEntity[] = [
  { id: 'customer', name: 'Customer', kind: 'person', responsibility: 'Browses products and places orders', x: -590, y: -45, width: 190, height: 112, confidence: 1, tags: ['external'] },
  { id: 'storefront', name: 'Storefront', kind: 'container', responsibility: 'Customer-facing commerce experience', technology: 'Next.js · React', x: -295, y: -70, width: 220, height: 132, confidence: 0.98, source: 'apps/storefront/src/app.tsx' },
  { id: 'gateway', name: 'Public API', kind: 'container', responsibility: 'Authenticates and routes public requests', technology: 'TypeScript · Fastify', x: 30, y: -72, width: 226, height: 136, confidence: 0.94, source: 'apps/api/src/server.ts' },
  { id: 'identity', name: 'Identity', kind: 'component', responsibility: 'Validates sessions and authorization policy', technology: 'JWT · OIDC', x: 358, y: -252, width: 216, height: 126, confidence: 0.91, source: 'apps/api/src/auth/middleware.ts' },
  { id: 'catalog', name: 'Catalog', kind: 'component', responsibility: 'Searches sellable products and inventory', technology: 'TypeScript', x: 370, y: -70, width: 216, height: 126, confidence: 0.89, source: 'apps/api/src/catalog/service.ts' },
  { id: 'orders', name: 'Order service', kind: 'component', responsibility: 'Coordinates checkout and order lifecycle', technology: 'Rust · Axum', x: 360, y: 120, width: 226, height: 136, confidence: 0.96, source: 'services/orders/src/lib.rs', tags: ['critical path'] },
  { id: 'payments', name: 'Payments', kind: 'system', responsibility: 'Authorizes and captures card payments', technology: 'Stripe', x: 722, y: 90, width: 210, height: 126, confidence: 0.87, tags: ['external'] },
  { id: 'order-db', name: 'Orders DB', kind: 'store', responsibility: 'Persists orders and payment state', technology: 'PostgreSQL 16', x: 354, y: 336, width: 214, height: 122, confidence: 0.99, source: 'infra/postgres/orders.sql' },
  { id: 'events', name: 'Commerce events', kind: 'queue', responsibility: 'Distributes durable domain events', technology: 'Kafka', x: 700, y: 330, width: 220, height: 122, confidence: 0.92, source: 'infra/kafka/topics.yaml' },
  { id: 'fulfilment', name: 'Fulfilment worker', kind: 'container', responsibility: 'Reserves stock and dispatches orders', technology: 'Go', x: 1030, y: 320, width: 230, height: 128, confidence: 0.9, source: 'services/fulfilment/main.go' },
];

export function createCommerceFixture(seed: number): AtlasScene {
  const random = seededRandom(seed);
  const entities = baseEntities.map((entity, index) => ({
    ...entity,
    x: entity.x + (index > 2 ? Math.round((random() - 0.5) * 18) : 0),
    y: entity.y + (index > 2 ? Math.round((random() - 0.5) * 14) : 0),
  }));

  return {
    id: `commerce-${seed}`,
    title: 'Acme Commerce',
    subtitle: 'production · main@8f1c2ab',
    entities,
    regions: [
      { id: 'boundary-commerce', name: 'ACME COMMERCE PLATFORM', showLabel: false, x: -350, y: -330, width: 1000, height: 850 },
      { id: 'boundary-external', name: 'CONNECTED SERVICES', x: 665, y: -25, width: 630, height: 545 },
    ],
    relations: [
      { id: 'customer-store', from: 'customer', to: 'storefront', label: 'Browses and buys', protocol: 'HTTPS' },
      { id: 'store-api', from: 'storefront', to: 'gateway', label: 'Requests products & checkout', protocol: 'JSON/HTTPS' },
      { id: 'api-identity', from: 'gateway', to: 'identity', label: 'Validates session', protocol: 'in-process' },
      { id: 'api-catalog', from: 'gateway', to: 'catalog', label: 'Finds products', protocol: 'in-process' },
      { id: 'api-orders', from: 'gateway', to: 'orders', label: 'Creates order', protocol: 'gRPC' },
      { id: 'orders-payments', from: 'orders', to: 'payments', label: 'Authorizes payment', protocol: 'HTTPS' },
      { id: 'orders-db', from: 'orders', to: 'order-db', label: 'Writes order', protocol: 'SQL' },
      { id: 'orders-events', from: 'orders', to: 'events', label: 'Publishes OrderPlaced', protocol: 'Kafka' },
      { id: 'events-fulfilment', from: 'events', to: 'fulfilment', label: 'Consumes OrderPlaced', protocol: 'Kafka' },
    ],
  };
}
