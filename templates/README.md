# Templates Folder:
This folder contains all HTML templates used in the Free Food Map web application.  
These templates are rendered by the Flask backend and define the user interface for public users, volunteers, organizations, and administrators.

# Project Context:
The Free Food Map is a platform designed to help users find free food resources through a centralized, searchable system.  
It combines verified data, community contributions, and administrative workflows to maintain accuracy and scale.

# Page Breakdown:

## 1. index.html
Landing page for the platform
Introduces the project and its purpose
Provides navigation to:
  - Map
  - Suggest location
  - Login / Sign up

### TO-DO:
  - [ ] Stronger mission explanation (Mission, visin)
  - [ ] introduction into the project
  - [ ] Data validation explanation 
  - [ ] Trust metrics (locations, partners, users)
  - [ ] FAQ section
  - [ ] SEO-focused content

## 2. public_map.html
Main public map interface
Displays map (Google My Maps iframe)
Allows ZIP-based search
Shows results in a table with:
  - location details
  - organization
  - contact info
  - events
  - Allows users to report issues

### TO-DO:
  - [ ] “Call before visiting” notice
  - [ ] Distance-based search
  - [ ] Filters (type, hours, organization)
  - [ ] Last verified / updated field
  - [ ] Verification badges
  - [ ] Pagination
  - [ ] Suggest edit option
  - [ ] Replace iframe with integrated map (future)
  - [ ] SEO-friendly location cards

## 3. suggest_location.html
Allows users to submit new locations
Collects:
  - name, address, ZIP
  - service type
  - organization
  - hours, contact info
  - notes

### TO-DO:
  - [ ] Source link field
  - [ ] Label Optional vs. Required fields
  - [ ] Address autocomplete
  - [ ] Duplicate detection and Submission tracking
  - [ ] Categorize type (event, recurring, etc.)

## 4. login.html
User login form (email + password)
Displays error messages if the login info are inccorrect

### TO-DO:
  - [ ] Forgot password
  - [ ] Remember me
  - [ ] Show/hide password
  - [ ] Link to registration
  - [ ] Pending approval message
  - [ ] Better error feedback

## 5. registration.html
User registration form
Collects:
  - [ ] personal info
  - [ ] organization
  - [ ] role
  - [ ] reason for joining

### TO-DO:
  - [ ] Confirm password
  - [ ] Password strength indicator
  - [ ] Email verification
  - [ ] Terms/privacy checkbox
  - [ ] Skills/interests field
  - [ ] Role descriptions
  - [ ] CAPTCHA (future)

## 6. volunteer_dashboard.html
Displays available events
Shows events user signed up for
Allows event signup

### TO-DO:
  - [ ] Event location + description
  - [ ] Cancel signup
  - [ ] Volunteer history
  - [ ] Hours tracking
  - [ ] Filters (date, location)
  - [ ] Email reminders
  - [ ] Impact summary (events joined)


## 7. org_dashboard.html
Main dashboard for organization users
Links to:
  - Locations
  - Reports
  - Events
  - Inventory

### TO-DO:
  - [ ] Counts (locations, reports, events)
  - [ ] Alerts (open issues, low inventory)
  - [ ] Recent activity
  - [ ] Quick actions (add event, update location)

## 8. org_events.html
Manage organization events
Add, edit, delete events

### TO-DO:
  - [ ] Event location
  - [ ] Volunteer count
  - [ ] Event status
  - [ ] Description
  - [ ] Recurring events
  - [ ] Filters and sorting

## 9. org_location.html
Manage organization locations
Edit and delete locations

### TO-DO:
  - [ ] Last verified field
  - [ ] Report count
  - [ ] Public view link
  - [ ] Status (active/inactive)
  - [ ] Map preview
  - [ ] Edit history
  - [ ] Temporary closure option

## 10. admin_dashboard.html
Central admin control panel
Links to:
  - users
  - locations
  - organizations
  - reports
  - events
  - suggestions

### TO-DO:
  - [ ] Counts (pending, reports, etc.)
  - [ ] Alerts
  - [ ] Quick stats
  - [ ] Activity feed
  - [ ] Shortcuts

## 11. admin_pending.html
Approve or deny user registrations

### TO-DO:
  - [ ] Requested role
  - [ ] Submission date
  - [ ] Admin notes
  - [ ] Bulk actions
  - [ ] Filters/search
  - [ ] Email notifications

## 12. admin_users.html
Manage users
Edit or delete users

### TO-DO:
  - [ ] Organization name (not ID)
  - [ ] Search and filters
  - [ ] Status (active/pending)
  - [ ] Last login
  - [ ] Export data
  - [ ] User profile view

## 13. admin_users_edit.html
Edit user details (role, org, email)

### TO-DO:
  - [ ] Password reset
  - [ ] Status field
  - [ ] Admin notes
  - [ ] Role change warnings
  - [ ] Audit tracking

## 14. admin_locations.html
Manage approved locations
Edit or delete locations

### TO-DO:
  - [ ] Search and filters
  - [ ] Order by column
  - [ ] Multiple pages, 25-50 location per page
  - [ ] Last updated field
  - [ ] Report count
  - [ ] Status flags
  - [ ] Map preview
  - [ ] Duplicate merge tool

## 15. admin_location_suggestions.html
Review user-submitted locations
Approve or reject

### TO-DO:
  - [ ] Edit before approve
  - [ ] Duplicate detection
  - [ ] Source/proof field
  - [ ] Admin notes
  - [ ] Status filters

## 16. admin_reports.html
Displays reported issues
Allows marking as resolved
Links to edit location

### TO-DO:
  - [ ] Report categories
  - [ ] Filters (open/resolved)
  - [ ] Resolution notes
  - [ ] Assigned reviewer
  - [ ] Priority level

## 17. admin_events.html
Manage all events
Edit, delete, create

### TO-DO:
  - [ ] Status (upcoming/completed)
  - [ ] Volunteer count
  - [ ] Filters
  - [ ] Sorting
  - [ ] Bulk actions
  - [ ] Recurring events

## 18. admin_events_new.html
Create new event

### TO-DO:
  - [ ] Time field
  - [ ] Description
  - [ ] Volunteer cap
  - [ ] Contact info
  - [ ] Validation checks

## 19. admin_events_edit.html
Edit existing event

### TO-DO:
  - [ ] Same improvements as new event page
  - [ ] Status field
  - [ ] Location preview

## 20. admin_organizations.html
Manage organizations
Create, edit or delete

### TO-DO:
  - [ ] Merge organizations (important)
  - [ ] Location count
  - [ ] Search
  - [ ] Duplicate detection
  - [ ] Status field

## 21. admin_organizations_new.html
Create new organization

### TO-DO:
  - [ ] Create an organization **Python side**
  - [ ] decide between having a 'Cancel' botton or 'Back' botton
  - [ ] Duplicate check
  - [ ] Contact details
  - [ ] Organization type
  - [ ] Success messages

## 22. admin_organizations_edit.html
Edit organization name

### TO-DO:
  - [ ] Contact info
  - [ ] Duplicate warning
  - [ ] Linked data preview
  - [ ] Notes


# General Improvements:

##  1. Base Template
  - Create base.html for shared layout (navbar, styling)

##  2. Flash Messages
  - Standardize success/error messages across all pages

##  3. Validation
  - Improve input validation (ZIP, email, phone, URL)

##  4. Search & Filters
  - Add to all admin tables

##  5. Audit Tracking
  - Track changes (who, when, what)

##  6. Data Verification System
  - Last verified
  - Verified by
  - Report count

##  7. Accessibility
  - Better labels
  - Keyboard navigation
  - Contrast improvements

##  8. SEO & Trust
  - Call-before-visit messaging
  - Last updated timestamps
  - Structured metadata
  - Priority Next Features
  - Improve public_map.html (filters, verification info)
  - Enhance suggest_location.html (validation + duplicate detection)
  - Upgrade admin_location_suggestions.html (edit + smarter approval)
  - Improve admin_locations.html (report tracking + filtering)
  - Complete organization merge feature
  - Expand volunteer dashboard features
