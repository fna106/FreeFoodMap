# Free Food Map:

A centralized platform designed to help people quickly find free food resources (food pantries, community meals, etc.) in their area.

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
- Flask (Python)
- PostgreSQL (database)

## Frontend
- HTML (Flask templates)
- Bootstrap (styling)

## Infrastructure
- Previously: Azure (App Service + DB)
- Moved to: Google Cloud (lower cost, better scaling)

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
- ~500+ locations collected (primarily Pennsylvania)
- Sources:
  - Web scraping
  - Organization websites
  - Manual validation

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
/templates → HTML pages
/main.py → Flask backend
/database → PostgreSQL schema


---

# Current Status

- [X] Backend (Flask)
- [X] Database (PostgreSQL)
- [X] Public map + search
- [X] Admin system
- [X] User registration + roles
- [X] ~500+ locations
- [X] Migration to Google Cloud
- [X] Domain integration (freefoodmap.org)
- [ ] Scraping improvements (In Progress)
- [ ] Data coverage (beyond PA)
- [ ] UI/UX improvements (In Progress)
- [ ] Automation pipeline
- [ ] SEO optimization

---

# TODO / Roadmap

## High Priority

### Public Experience
- [ ] Add “Call before visiting” notice
- [ ] Add filters (distance, service type, hours)
- [ ] Add “last verified” field
- [ ] Add verification badges
- [ ] Improve map integration (replace iframe long-term)

---

### Data Quality
- [ ] Add report issue system improvements
- [ ] Add verification tracking:
  - [ ] last updated
  - [ ] verified by
- [ ] Add duplicate detection for locations
- [ ] Add edit-before-approve for suggestions

---

### Scraping & Automation
- [ ] Build AI scraping agent
- [ ] Build web crawler for discovering sources
- [ ] Improve scraping reliability (handle dynamic pages)
- [ ] Explore Facebook data access options

---

### Infrastructure
- [ ] Complete migration to Google Cloud
- [ ] Fully deploy using freefoodmap.org
- [ ] Optimize performance and cost

---

## Medium Priority

### Admin Tools
- [ ] Add search and filters to all admin tables
- [ ] Add report categories (wrong hours, closed, etc.)
- [ ] Add resolution notes for reports
- [ ] Add user status (active/pending/suspended)
- [ ] Add organization merge feature
- [ ] Add analytics dashboard (counts, activity)

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
- [ ] Add stronger validation (email, phone, ZIP)
- [ ] Add duplicate warnings on submission
- [ ] Add source link for location submissions
- [ ] Add “I verified this” checkbox

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
- [ ] Structured metadata for search engines
- [ ] Improve page speed
- [ ] Add accessibility improvements (ARIA, keyboard nav)
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
- a dataset of 500+ locations

We are now focused on:
- scaling data
- improving automation
- increasing reliability and accessibility

---
