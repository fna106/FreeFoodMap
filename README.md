# Free Food Map:

A centralized platform designed to help people quickly find free food resources (food pantries, community meals, etc.) in their area.

---

## Serverless PWA conversion

The new application is in [app/](app/README.md). It replaces the continuously running Flask/PostgreSQL deployment with:

- a Cloudflare Worker serving the PWA and API
- Cloudflare D1 for locations, suggestions, reports, and review history
- an installable Leaflet/OpenStreetMap experience
- a protected admin review queue
- scheduled geocoding and automatic GitHub deployments
- on-demand cached search that avoids downloading all locations on page load
- clustered maps, structured opening hours, and community visit updates
- automated source verification with a human review queue
- crawlable location pages and an open-data export

The original Flask application remains in the repository as a migration reference until the new deployment is verified.

---

# Overview

Access to free food resources is often difficult because information is:
- scattered across multiple websites
- outdated or inconsistent
- hard to verify in real time

The Free Food Map solves this by creating a **single, searchable platform** that combines:
- structured data
- community contributions
- admin validation workflows

The goal is to make food access **faster, more reliable, and scalable across regions**.

---

# Key Features

## Public Users
- Search for food locations by ZIP code
- View locations on a map
- See details (address, services, contact info, events)
- Report incorrect information
- Suggest new locations

## Volunteers
- View available events
- Sign up for events
- Track participation (future)

## Organizations
- Manage their own locations
- Manage events
- View reports related to their locations

## Admins
- Approve user registrations
- Manage locations, organizations, and users
- Review location suggestions
- Handle issue reports
- Manage events

---

# Tech Stack

## Backend
- Cloudflare Worker (TypeScript)
- Cloudflare D1 (serverless SQL database)

## Frontend
- Installable progressive web app
- HTML, CSS, and JavaScript
- Leaflet + OpenStreetMap for the public map

## Infrastructure
- Cloudflare Workers Static Assets + D1
- GitHub Actions for tests, migrations, and deployment
- Legacy Flask/PostgreSQL source retained during rollout

## Domain
- freefoodmap.org

---

# Data Model Approach

The system is built around:

- Locations
- Organizations
- Events
- Users
- Reports (issues)
- Suggestions (user-submitted locations)

---

# Data Strategy

## 1. Initial Data Collection
- 448 active, searchable Pennsylvania locations as of September 1, 2026
- Sources:
  - Web scraping
  - Organization websites
  - Manual validation
  - Pennsylvania 211 records cross-checked with U.S. Census coordinates

---

## 2. Validation Model (Key Idea)

We are moving toward a **hybrid validation system**:

### Admin Validation
- Admin approval required for:
  - new locations
  - user submissions

### Community Validation
- Users are encouraged to:
  - call locations before visiting
  - report incorrect data

### Goal
Create a **semi open-source dataset** where:
- data is scalable
- accuracy is maintained througha public feedback loops

---

# Scraping & Automation

## Current
- Python scraping (BeautifulSoup / requests)
- Limited by:
  - 403 blocks
  - dynamic websites
  - inconsistent structures
  - robots.txt

---

## Future Direction

### AI-Based Scraping Agent
- Use an LLM to:
  - navigate websites
  - extract structured data
- Reduces need for brittle scrapers

### Web Crawlers
- Automatically discover relevant websites
- Feed them into the AI agent

### Facebook Data Exploration
- Many food pantries operate via Facebook pages
- Need to explore:
  - Facebook API access
  - legal and technical constraints
  - alternative data collection methods

---

# Scaling Strategy

## Geographic Expansion
- Partner with universities and student teams
- Each group contributes local data

## Community Contributions
- Users submit and report data
- Creates distributed data model

## SEO (Critical)
Goal:
Appear when users search:
- “free food near me”
- “food pantry open today”

---

# Project Structure
- `/app/public` - installable map interface
- `/app/src` - Worker API and automation
- `/app/migrations` - D1 schema and imported location data
- `/templates` and `/main.py` - legacy Flask application


---

# Current Status

## Completed in the latest implementation pass
- Public pages now use the side HTML/CSS design direction.
- The public map uses Leaflet + OpenStreetMap instead of a Google My Maps iframe.
- ZIP search supports service type, organization, and listed-hours filters.
- Public location suggestions now validate ZIP, email, phone, and URL fields.
- Location suggestions now warn on basic duplicates before creating a pending record.
- Suggestion submissions can include a source link and a recently verified checkbox.
- Login includes a show/hide password control and clearer registration guidance.
- Registration includes confirm password, password strength help, stronger validation, and duplicate account checks.
- Major admin tables now include client-side search.
- Public pages include basic SEO metadata and accessibility labels.

- [X] Backend (Flask)
- [X] Database (PostgreSQL)
- [X] Public map + search
- [X] Admin system
- [X] User registration + roles
- [X] 448 active Pennsylvania locations
- [X] Serverless PWA conversion built and verified locally
- [X] Production Cloudflare deployment and domain cutover
- [X] Domain integration (freefoodmap.org)
- [X] Conservative automated source verification pipeline
- [ ] Data coverage (beyond PA)
- [ ] UI/UX improvements (In Progress)
- [X] Automation pipeline
- [X] SEO location pages, sitemap, and structured data

---

# TODO / Roadmap

## High Priority

### Public Experience
- [X] Add “Call before visiting” notice
- [X] Add basic filters (service type, organization, listed hours)
- [X] Add nearby distance search after locations have latitude/longitude
- [X] Add “last verified” and last reviewed fields
- [X] Add verification badges and field-level source evidence
- [X] Improve map integration (replace iframe long-term)

---

### Data Quality
- [ ] Add report issue system improvements
- [X] Add verification tracking:
  - [X] last reviewed and last verified dates
  - [X] source URL and exact confirmed fields
- [X] Add basic duplicate detection for suggested locations
- [X] Add edit-before-approve for suggestions

---

### Scraping & Automation
- [ ] Build AI scraping agent
- [ ] Build web crawler for discovering sources
- [X] Improve verification reliability with Browser Rendering fallback
- [ ] Explore Facebook data access options

---

### Infrastructure
- [ ] Create the production D1 database
- [ ] Deploy the Worker and connect freefoodmap.org
- [ ] Verify production data, then archive the legacy Flask deployment
- [X] Optimize performance and cost with scoped queries, edge caching, lazy map assets, and clustering

---

## Medium Priority

### Admin Tools
- [X] Add search to major admin tables
- [X] Add report categories (wrong hours, closed, etc.)
- [X] Add resolution notes for reports
- [ ] Add user status (active/pending/suspended)
- [ ] Add organization merge feature
- [X] Add admin activity and verification metrics

---

### Organization Features
- [ ] Add event descriptions and volunteer caps
- [ ] Add location status (active/inactive)
- [ ] Add report tracking per location
- [ ] Add organization-level analytics

---

### Volunteer Features
- [ ] Add volunteer history
- [ ] Add hours tracking
- [ ] Add cancel signup
- [ ] Add event reminders

---

### Forms & Validation
- [X] Add stronger validation (email, phone, ZIP, URL)
- [X] Add duplicate warnings on submission
- [X] Add source link for location submissions
- [X] Add “I verified this” checkbox

---

## Long-Term

### AI & Intelligence
- [ ] Natural language search (“food near me open now”)
- [ ] Automatic data cleaning using AI
- [ ] Duplicate detection using embeddings
- [ ] Smart prioritization of reports

---

### Platform Growth
- [ ] Expand to multiple states
- [ ] Build partnerships (universities, nonprofits)
- [ ] Open-source location dataset (controlled)

---

### SEO & Accessibility
- [X] Structured metadata for search engines
- [X] Improve page speed with on-demand data and map loading
- [X] Add basic accessibility improvements (labels, ARIA navigation, responsive layout)
- [ ] Improve content for discoverability

---

# Vision

Build a **nationwide, reliable platform** for accessing free food resources.

Used by:
- individuals in need
- organizations
- researchers
- communities

Powered by:
- structured data
- community validation
- automation and AI

---

# Contributing

We welcome contributors in:
- data collection
- validation
- frontend/backend development
- scraping and automation
- partnerships and outreach

---

# Summary

We have built:
- a working system (backend + database + frontend)
- a verified production dataset of 448 active Pennsylvania locations

We are now focused on:
- scaling data
- improving automation
- increasing reliability and accessibility

---
