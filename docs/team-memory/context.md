# Context

This is PDGGK's private reading of the ByteDance Douyin E-commerce AI Full Stack challenge. The official task is “实时竞拍大师”: build a live auction full-stack system with React/TypeScript, WebSocket, backend services, MySQL/Redis, and a complete flow from product listing to bid ranking and transaction result.

Key dates are fixed by the PDF: topic briefing on 2026-05-20, mentor assignment on 2026-05-21, challenge work from 2026-05-20 to 2026-06-10, demos on 2026-06-11 to 2026-06-12. V8 uses 2026-06-08 as the internal freeze, which should be treated as buffer, not the official external deadline.

The scoring shape matters: 50% engineering completeness, 25% technical depth, 15% AI usage, 10% materials. The winning path is not “AI host” alone and not “Redis tricks” alone. It needs a working auction loop, credible real-time consistency, visible AI usage with human review, and clean demo/report evidence.

Constraints: keep auctions transparent and single-item; avoid mystery box, random card break, gambling-like framing, authenticity guarantees, and real payment/logistics promises. AI can help draft facts and atmosphere, but backend state and seller confirmation own truth.
