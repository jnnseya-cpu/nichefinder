# Niche Finder

Niche Finder is a venture infrastructure operating system, designed to help entrepreneurs find, validate, and build fundable business ideas with data-driven confidence.

## Repository structure

```
frontend/   The OS surface — all pages (Search Canvas, Command Center, Deep-Dive,
            Super Admin OS, Comms Engine, Government Mode, public + legal pages),
            the design system (page.css, nf-polish.css), the client wallet
            (nf-wallet.js), support concierge, consent layer, and the PWA shell
            (manifest, sw.js, icon).
backend/    The AI gateway (backend/gateway) — zero-framework Node service with
            claude → gemini → openai failover, ACU metering, and the wallet
            system of record (file store today, Postgres in P1). Wallet store is
            AES-256-GCM encrypted at rest when WALLET_STORE_KEY is set.
shared/     Single source of truth used by BOTH sides:
            nf-economy.js — the canonical ACU economy (packages, action prices,
              capital-bracket law). The client displays what the server enforces,
              from the same file.
            nf-crypto.js — AES-256-GCM encryption module (WebCrypto, runs in
              browser and Node) implementing the end-to-end encryption law.
docs/       Architecture + the production-grade AI-OS transformation spec.
```

Run the backend: `cd backend/gateway && npm start` · Tests: `node test/smoke.js`
Serve the frontend from the repo root (so `frontend/` pages can load `../shared/`):
`python3 -m http.server` → http://localhost:8000/frontend/

## Our Mission

Our mission is to eliminate the primary cause of startup failure: building a product for a market that doesn't exist. We empower founders, builders, and investors with an OS that systematically uncovers high-potential niches, validates their commercial viability, and accelerates the path from idea to investor-ready venture.

## The Problem We Exist to Solve

Millions of brilliant business ideas fail not because of poor execution, but because they are launched into poorly chosen markets with no real, validated demand. Traditional market research is slow, expensive, and often reliant on intuition. Aspiring entrepreneurs, particularly those with limited capital, lack the tools to identify opportunities with a genuine, validated prospect of success. The result is wasted time, wasted capital, and unrealised potential.

## What Niche Finder Does

Niche Finder is a venture infrastructure operating system that transforms your initial constraints — such as country, industry, and budget — into a ranked list of specific, fundable business opportunities. Our system goes beyond generic ideas, providing deep analysis, automated financial modeling, and a clear, data-driven rationale for each recommendation.

## What Makes Our Platform Different

We are not a simple idea generator. Niche Finder is an end-to-end operating system for opportunity validation and venture creation. Our key differentiators are:

- **Autonomous Venture Intelligence** — Our system combines multiple AI layers to discover, score, and validate opportunities with commercial depth.
- **Proprietary Venture Scorecard** — Every niche is evaluated against dozens of data points, resulting in a clear, comparable Overall Confidence Score that reflects its readiness, competitiveness, and prospect of success.
- **Execution-Ready Outputs** — For each project, we provide a suite of investor-ready documents and financial models, enabling you to move from validation to fundraising with structured, professional assets.

## How Our Model Works

Niche Finder operates on a transparent, pay-as-you-go model using Application Credit Units (ACUs). This ensures you only pay for the value you receive. You are granted a complimentary balance upon signing up to explore the platform's read-only features. Paid ACUs are then consumed for specific, high-value actions such as generating new venture opportunities or creating investor-grade documents. Our model is designed for controlled, predictable consumption, putting you in charge of your spending.

## Our Approach to Venture Intelligence

We view our platform's intelligence as a powerful co-pilot, not a replacement for human judgment. Our system is trained to act as a world-class venture analyst, processing vast amounts of information to identify patterns and opportunities that humans might miss. However, we stress that all generated outputs — from financial forecasts to market risks — are probabilistic and require your critical review. Our platform is a tool to enhance your decision-making, not to make decisions for you.

## Who We Serve

Niche Finder is designed for ambitious entrepreneurs, early-stage founders, startup incubators, and angel investors who need a structured, data-driven approach to identifying and validating new ventures.
