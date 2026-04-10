from flask import Flask, render_template, request, redirect, session
from postgres_database_configuration import get_db_connection
import hashlib
import os

app = Flask(__name__)
app.secret_key = os.getenv("APP_SECRET_KEY", "dev-secret")



# using hashing SHA-1 and salt to create passwords for users without storing them in db

def sha1_hash(password, salt=None):
    if salt is None:
        salt = os.urandom(16).hex()

    hash_obj = hashlib.sha1()
    hash_obj.update((salt + password).encode("utf-8"))
    password_hash = hash_obj.hexdigest()
    return salt, password_hash


def verify_password(stored_hash, stored_salt, entered_password):
    _, test_hash = sha1_hash(entered_password, salt=stored_salt)
    return stored_hash == test_hash


# a function to take us to the home page
@app.route("/", methods=["GET", "POST"])
def index():
    return render_template("index.html")


# a function that will take us to the map page
@app.route("/map")
def public_map():
    return render_template("public_map.html")


# a function for the registration page
@app.route("/register", methods=["GET", "POST"])
def register():
    conn = get_db_connection()
    cur = conn.cursor()

    # this part send a query to the database to get all the organizations to display them if the org exists so the user can just choose it instead of entering the name
    cur.execute("SELECT org_id, name FROM freefoodmap.Organization ORDER BY name;")
    organizations = cur.fetchall()

    roles = ["Org Staff", "Volunteer"]

    if request.method == "POST":
        name = request.form["name"]
        email = request.form["email"]
        username = request.form["username"]
        password = request.form["password"]
        reason = request.form["reason"]
        role_requested = request.form["role"]
        phone_number = request.form["phone_number"]

        org_choice = request.form.get("organization")
        other_org = request.form.get("organization_other")

        # giving the user the option to add their org name after selecting "OTHER"
        if org_choice == "OTHER":
            organization = other_org.strip() if other_org else None
        else:
            organization = org_choice if org_choice else None

        # hashing password
        salt, password_hash = sha1_hash(password)

        # once they submit a request, their info is saved in the ContributorRequest table
        cur.execute("""
            INSERT INTO freefoodmap.ContributorRequest
            (name, email, phone_number, organization, reason, username, password_hash, salt, role_requested, decision)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'pending')
        """, (name, email, phone_number, organization, reason, username, password_hash, salt, role_requested))

        conn.commit()
        cur.close()
        conn.close()

        # once they click the submit button, they recieve the messege below
        return render_template(
            "registration.html",
            organizations=organizations,
            roles=roles,
            success_message="Your registration request has been submitted and is pending approval."
        )

    cur.close()
    conn.close()
    return render_template("registration.html", organizations=organizations, roles=roles)



# a function for loging in as an existing user who was already approved by the admin
@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        email = request.form["email"]
        password = request.form["password"]

        conn = get_db_connection()
        cur = conn.cursor()

        # this query checks if the email exists in the database
        cur.execute("""
            SELECT user_id, username, password_hash, salt, role, org_id
            FROM freefoodmap.appuser
            WHERE email = %s
        """, (email,))

        row = cur.fetchone()
        cur.close()
        conn.close()

        if row:
            user_id, username, stored_hash, salt, role, org_id = row

            if verify_password(stored_hash, salt, password):

                # we save the user's id, username, and role in the session so we know who they are for later requests that need specific permissions
                session["user_id"] = user_id
                session["username"] = username
                session["role"] = role
                session["org_id"] = org_id

                # we have 3 types of dashboards, use is directed to the correct one based on their role
                if role == "admin":
                    return redirect("/admin")

                elif role == "Org Staff":
                    return redirect("/org/dashboard")

                elif role == "Volunteer":
                    return redirect("/volunteer")

        # if the email or password is incorrect, we show an error message
        return render_template("login.html", error="Incorrect email or password.")

    return render_template("login.html")




# a function for logging out the user
@app.route("/logout")
def logout():
    session.clear() #clean everything that was saved so they can't access anything they shouldn't
    return redirect("/")


# creating a function that makes sure that only the admin can access the admin dashboard (extra safety net)
@app.route("/admin")
def admin_dashboard():
    role = session.get("role")

    if role not in ["admin"]:
        return render_template(
            "index.html"
        )
    return render_template("admin_dashboard.html")

# a function for the admin to approve or deny a new user request
@app.route("/admin/pending")
def admin_pending():
    role = session.get("role")

    #safety net, incase someone somehow accessed the page they will get kicked out
    if role != "admin":
        return render_template(
            "index.html",
        )

    conn = get_db_connection()
    cur = conn.cursor()

    # a query that gets all the pending user requests
    cur.execute("""
        SELECT request_id, name, email, organization, reason, role_requested
        FROM freefoodmap.ContributorRequest
        WHERE decision = 'pending'
    """)

    rows = cur.fetchall()
    cur.close()
    conn.close()


    users = [
        {
            "request_id": r[0],
            "name": r[1],
            "email": r[2],
            "organization": r[3],
            "reason": r[4],
            "role_requested": r[5]
        }
        for r in rows
    ]

    return render_template("admin_pending.html", users=users)

# we are considering this as a transactional function, and we will implement a rollback and commit functionalities to it
@app.route("/admin/approve/<int:request_id>")
def approve_user(request_id):
    role = session.get("role")

    #safety net, incase someone somehow accessed the page they will get kicked out
    if role != "admin":
        return render_template(
            "index.html",
        )

    conn = get_db_connection()
    cur = conn.cursor()

    try:
        cur.execute("BEGIN;")

        # a query that gets the user request details from the ContributorRequest table to start the approval process
        cur.execute("""
            SELECT name, email, phone_number, username, password_hash, salt, 
                   role_requested, organization
            FROM freefoodmap.ContributorRequest
            WHERE request_id = %s AND decision = 'pending'
        """, (request_id,))

        row = cur.fetchone()

        # facing a problem with some request that are not pending anymore, so we added this to stop the approval process
        if not row:
            conn.rollback()
            cur.close()
            conn.close()
            return render_template(
                "admin_pending.html"
            )

        (name, email, phone_number, username, password_hash, salt,
         role_requested, org_name) = row

        # this part is placed in an attempt to make sure there is no organization with the same name being entered (trying to prevent dubs)
        org_id = None

        if role_requested == "Org Staff" and org_name:
            org_name_clean = org_name.strip()

            # unfortunately, if the spelling is different, this part will fail
            cur.execute("""
                SELECT org_id FROM freefoodmap.Organization
                WHERE LOWER(name) = LOWER(%s)
            """, (org_name_clean,))
            existing = cur.fetchone()

            if existing:
                org_id = existing[0]
            else:
                # if the code below didn't see an organization with the same name, it will create one
                cur.execute("""
                    INSERT INTO freefoodmap.Organization (name)
                    VALUES (%s)
                    RETURNING org_id
                """, (org_name_clean,))
                org_id = cur.fetchone()[0]

        # this part will ensure that the user we are approving has a unique username and email. Since these requests are initially stored at ContributorRequest table, we can only check later if they exist as a user when we try to approve them. (Future addition: check if we can validate them against user table before allowing them to submit the request)
        # Reject if username or email already exists
        cur.execute("""SELECT 1 FROM freefoodmap.appuser WHERE username = %s""", (username,))
        if cur.fetchone():
            raise Exception("Username already exists. Cannot approve.")

        cur.execute("""SELECT 1 FROM freefoodmap.appuser WHERE email = %s""", (email,))
        if cur.fetchone():
            raise Exception("Email already exists. Cannot approve.")

        # once we have verified that the username and email are unique, we can create the user account
        cur.execute("""
            INSERT INTO freefoodmap.appuser (username, password_hash, salt, email, phone_number, role, org_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        """, (username, password_hash, salt, email, phone_number, role_requested, org_id))

        # once the user is created, we can approve the request (change the request type in the ContributorRequest table to 'approved')
        cur.execute("""
            UPDATE freefoodmap.ContributorRequest
            SET decision = 'approved'
            WHERE request_id = %s
        """, (request_id,))

        conn.commit() #if all the code above runs without any errors, we commit the transaction
        cur.close()
        conn.close()

        return redirect("/admin/pending") #refreshes the page after approving a user request

    except Exception as e:

        conn.rollback() #if any of the code above fails, we rollback the transaction
        cur.close()
        conn.close()

        return render_template(
            "admin_dashboard.html"
        )


# this part is the same as the approve_user function, except it denies the user request instead of approving it (change the decision type in the ContributorRequest table to 'rejected')
@app.route("/admin/deny/<int:request_id>")
def deny_user(request_id):
    role = session.get("role")

    if role != "admin":
        return render_template(
            "admin_dashboard.html",
        )

    conn = get_db_connection()
    cur = conn.cursor()

    cur.execute("""
        UPDATE freefoodmap.ContributorRequest
        SET decision = 'rejected'
        WHERE request_id = %s
    """, (request_id,))

    conn.commit()
    cur.close()
    conn.close()

    return redirect("/admin/pending") #refreshes the page after denying a user request


# in this part, we are giving public users (with no accounts) the ability to suggest new food locations so we can add them to our database and our map
@app.route("/suggest-location", methods=["GET", "POST"])
def suggest_location():
    if request.method == "POST":
        name = request.form["name"]
        address = request.form["address"]
        zip_code = request.form["zip_code"]
        service_type = request.form["service_type"]
        organization = request.form.get("organization")
        hours = request.form.get("hours")
        contact_phone = request.form.get("contact_phone")
        contact_email = request.form.get("contact_email")
        contact_web = request.form.get("contact_web")
        notes = request.form.get("notes")

        conn = get_db_connection()
        cur = conn.cursor()

            # this part takes all the info they provided and submit it to our LocationSuggestion table, where the admin will review it to make sure it's accurate first before adding it to the map
        cur.execute("""
            INSERT INTO freefoodmap.LocationSuggestion
            (name, address, zip_code, service_type, organization,
            hours, contact_phone, contact_email, contact_web, notes, status)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'pending')
        """, (
            name, address, zip_code, service_type, organization,
            hours, contact_phone, contact_email, contact_web, notes
        ))

        conn.commit()
        cur.close()
        conn.close()

        return render_template(
            "suggest_location.html",
            success_message=(
                "Thank you for contributing to our map and helping us combat hunger. "
                "We will add your suggestion once we approve it."
            )
        )
    return render_template("suggest_location.html")

# this page will show the admin all the location that exist in the database
@app.route("/admin/locations")
def admin_locations():
    role = session.get("role")

    if role != "admin":
        return render_template(
            "index.html"
        )

    conn = get_db_connection()
    cur = conn.cursor()


    cur.execute("""
            SELECT Location.location_id, Location.name, Location.address,
                   Location.zip_code, Location.service_type,
                   Organization.name AS org_name
            FROM freefoodmap.Location
        LEFT JOIN freefoodmap.Organization ON Location.org_id = Organization.org_id
        ORDER BY Location.location_id;
    """)

    rows = cur.fetchall()
    cur.close()
    conn.close()

    locations = [
        {
            "location_id": r[0],
            "name": r[1],
            "address": r[2],
            "zip_code": r[3],
            "service_type": r[4],
            "org_name": r[5]
        }
        for r in rows
    ]

    return render_template("admin_locations.html", locations=locations)


# public users can also report locations if they have incorrect information, in this part the admin
@app.route("/report-location/<int:location_id>")
def report_location(location_id):

    conn = get_db_connection()
    cur = conn.cursor()

    # this qurey will give us the location data from the view to be used in the report form
    cur.execute("""
        SELECT location_id,
               location_name,
               address,
               zip_code,
               service_type,
               hours,
               contact_phone,
               contact_email,
               contact_web,
               notes,
               organization_name
        FROM freefoodmap.ZipcodeLocationView
        WHERE location_id = %s
    """, (location_id,))

    row = cur.fetchone()

    (location_id, location_name, address, zip_code, service_type,
     hours, phone, email, web, notes, org_name) = row

    # if an existing user is reporting a location, the ID will be stored in the report
    user_id = session.get("user_id", None)

    # we are creating a description
    # NOTE: since this is auto-done, we don't need to worry about SQL injection attacks (at least I like to hope)
    description = f"""
    Auto-report for location: {location_id}
    Address: {address}
    ZIP: {zip_code}
    Organization: {org_name}
    Notes: {notes or 'None provided'}
    """

    cur.execute("""
        INSERT INTO freefoodmap.Report (user_id, description, location_id, status, report_date)
        VALUES (%s, %s, %s, 'Pending', CURRENT_DATE)
    """, (user_id, description.strip(), location_id))

    conn.commit()
    cur.close()
    conn.close()

    return render_template(
        "public_map.html",
        reported_message=f"The location '{location_name}' has been reported."
    )


# when a location is reported, it will show up for the admin
@app.route("/admin/reports")
def admin_reports():
    role = session.get("role")

    if role != "admin":
        return render_template(
            "index.html"
        )

    conn = get_db_connection()
    cur = conn.cursor()


    cur.execute("""
                    SELECT R.report_id,
                           R.user_id,
                           U.username,
                           R.type,
                           R.description,
                           R.status,
                           R.report_date,
                           L.name AS location_name,
                           L.location_id
                    FROM freefoodmap.Report R
                             LEFT JOIN appuser U ON R.user_id = U.user_id
                             LEFT JOIN Location L ON R.location_id = L.location_id
                    WHERE R.status != 'Resolved'
                    ORDER BY R.report_date DESC;
                """)

    rows = cur.fetchall()

    reports = [
        {
            "report_id": r[0],
            "user_id": r[1],
            "username": r[2] if r[2] else "Anonymous", # users with accounts can also report locations without, we are trying to distinguish where the report comes from
            "type": r[3] or "N/A",
            "description": r[4] or "(No description)",
            "status": r[5],
            "report_date": r[6],
            "location_name": r[7],
            "location_id": r[8]
        }
        for r in rows
    ]

    return render_template("admin_reports.html", reports=reports)


# this part will change the status of a report to Resolved so that it won't show up in the admin reports page anymore
@app.route("/admin/reports/resolve/<int:report_id>")
def resolve_report(report_id):
    role = session.get("role")

    if role != "admin":
        return render_template(
            "index.html"
        )

    conn = get_db_connection()
    cur = conn.cursor()

    #updating the status of the report to Resolved
    cur.execute("""
        UPDATE freefoodmap.Report
        SET status = 'Resolved'
        WHERE report_id = %s
    """, (report_id,))

    conn.commit()
    cur.close()
    conn.close()

    return redirect("/admin/reports") #updating the page, and any report that was resolved will no longer show up


# this will take the admin to the event page and show all the events that have been added to the database
@app.route("/admin/events")
def admin_events():

    role = session.get("role")
    if role != "admin":
        return render_template(
            "index.html"
        )

    conn = get_db_connection()
    cur = conn.cursor()

    cur.execute("""
        SELECT E.event_id, E.type, E.date,
                L.name AS location_name
        FROM freefoodmap.Event E
        JOIN freefoodmap.Location L ON E.location_id = L.location_id
        ORDER BY E.date DESC;
    """)

    rows = cur.fetchall()
    cur.close()
    conn.close()

    events = [
        {
            "event_id": r[0],
            "type": r[1],
            "date": r[2],
            "location_name": r[3]
        }
        for r in rows
    ]

    return render_template("admin_events.html", events=events)

# the admin can edit the info of an event and update it if needed
@app.route("/admin/events/edit/<int:event_id>", methods=["GET", "POST"])
def admin_edit_event(event_id):

    role = session.get("role")
    if role != "admin":
        return render_template(
            "index.html"
        )

    conn = get_db_connection()
    cur = conn.cursor()


    if request.method == "POST":
        event_type = request.form["type"]
        event_date = request.form["date"]
        org_id = request.form["org_id"]
        location_id = request.form["location_id"]

        cur.execute("""
            UPDATE freefoodmap.Event
            SET type = %s,
                date = %s,
                org_id = %s,
                location_id = %s
            WHERE event_id = %s
        """, (event_type, event_date, org_id, location_id, event_id))

        conn.commit()
        cur.close()
        conn.close()

        # takes the admin back to the events page to see the updated info
        return redirect("/admin/events")

    # will provide the original info of the event to be edited
    cur.execute("""
        SELECT event_id, type, date, org_id, location_id
        FROM freefoodmap.Event
        WHERE event_id = %s
    """, (event_id,))
    e = cur.fetchone()

    # we want to give the admin a list to the existing orgs
    cur.execute("SELECT org_id, name FROM freefoodmap.Organization ORDER BY name;")
    organizations = cur.fetchall()

    # and the existing locations
    cur.execute("SELECT location_id, name FROM freefoodmap.Location ORDER BY name;")
    locations = cur.fetchall()

    cur.close()
    conn.close()

    event_data = {
        "event_id": e[0],
        "type": e[1],
        "date": e[2],
        "org_id": e[3],
        "location_id": e[4],
    }

    return render_template("admin_events_edit.html",
                           event=event_data,
                           organizations=organizations,
                           locations=locations)


# this function to delete an event by the admin
@app.route("/admin/events/delete/<int:event_id>")
def admin_delete_event(event_id):

    role = session.get("role")
    if role != "admin":
        return render_template(
            "index.html"
        )

    conn = get_db_connection()
    cur = conn.cursor()

    cur.execute("DELETE FROM freefoodmap.Event WHERE event_id = %s", (event_id,))

    conn.commit()
    cur.close()
    conn.close()

    return redirect("/admin/events")


# in
@app.route("/admin/location-suggestions")
def admin_location_suggestions():

    role = session.get("role")
    if role != "admin":
        return render_template(
            "index.html"
        )

    conn = get_db_connection()
    cur = conn.cursor()

    # a query to get all the pending suggestions from the LocationSuggestion table
    cur.execute("""
        SELECT suggestion_id, name, address, zip_code, service_type,
               organization, hours, contact_phone, contact_email,
               contact_web, notes, submitted_at, status
        FROM freefoodmap.LocationSuggestion
        WHERE status = 'pending'
        ORDER BY submitted_at DESC;
    """)

    rows = cur.fetchall()
    cur.close()
    conn.close()

    # we use these lists to show the info on the HTML page
    suggestions = [
        {
            "suggestion_id": r[0],
            "name": r[1],
            "address": r[2],
            "zip_code": r[3],
            "service_type": r[4],
            "organization": r[5],
            "hours": r[6],
            "contact_phone": r[7],
            "contact_email": r[8],
            "contact_web": r[9],
            "notes": r[10],
            "submitted_at": r[11],
            "status": r[12]
        }
        for r in rows
    ]

    return render_template("admin_location_suggestions.html", suggestions=suggestions)

# once the admin presses the approval button, the blow code will run to check if the location already exists or not
# we consider adding locations to the database a sensitive point, and we want to make sure only correct info is added. So we will treat it as a transaction
@app.route("/admin/location-suggestions/approve", methods=["POST"])
def approve_location_suggestion():
    role = session.get("role")
    if role != "admin":
        return render_template(
            "index.html"
        )

    address = request.form.get("address")

    conn = get_db_connection()
    cur = conn.cursor()

    try:
        # our transaction logic starts here
        cur.execute("BEGIN;")

        # this query will retrieve the location info from the LoccationSuggestion table
        cur.execute("""
                    SELECT name,
                           address,
                           zip_code,
                           service_type,
                           organization,
                           hours,
                           contact_phone,
                           contact_email,
                           contact_web,
                           notes
                    FROM freefoodmap.LocationSuggestion
                    WHERE LOWER(address) = LOWER(%s)
                      AND status = 'pending'
                    """, (address,))

        row = cur.fetchone()

        (
            name, address, zip_code, service_type,
            organization, hours, contact_phone,
            contact_email, contact_web, notes
        ) = row

        # check it with the location table using address
        cur.execute("""
                    SELECT location_id
                    FROM freefoodmap.Location
                    WHERE LOWER(address) = LOWER(%s)
                    """, (address,))
        duplicate = cur.fetchone()


        # this message will appear if the location already exists
        if duplicate:
            raise Exception("A location with this address already exists.")

        # it will also check if the organization exists already or not, if not, we will create a new one, if it exists, we will just add the location under it
        org_id = None
        if organization and organization.strip():
            org_name_clean = organization.strip()

            cur.execute("""
                        SELECT org_id
                        FROM freefoodmap.Organization
                        WHERE LOWER(name) = LOWER(%s)
                        """, (org_name_clean,))

            existing_org = cur.fetchone()

            if existing_org:
                org_id = existing_org[0]
            else:
                cur.execute("""
                            INSERT INTO freefoodmap.Organization (name)
                            VALUES (%s) RETURNING org_id
                            """, (org_name_clean,))
                org_id = cur.fetchone()[0]

        # once it passes all the checks, we will add the location to the database
        cur.execute("""
                    INSERT INTO freefoodmap.Location
                    (name, address, zip_code, service_type, org_id,
                     hours, contact_phone, contact_email, contact_web, notes)
                    VALUES (%s, %s, %s, %s, %s,
                            %s, %s, %s, %s, %s)
                    """, (
                        name, address, zip_code, service_type, org_id,
                        hours, contact_phone, contact_email, contact_web, notes
                    ))

        # and change the status of the suggestion to approved
        cur.execute("""
                    UPDATE freefoodmap.LocationSuggestion
                    SET status = 'approved'
                    WHERE LOWER(address) = LOWER(%s)
                    """, (address,))

        conn.commit()
        cur.close()
        conn.close()

        return redirect("/admin/location-suggestions")

    except Exception as e:

        # if something goes wrong, we will roll back the transaction
        conn.rollback()
        cur.close()
        conn.close()


        conn2 = get_db_connection()
        cur2 = conn2.cursor()

        cur2.execute("""
                     SELECT suggestion_id,
                            name,
                            address,
                            zip_code,
                            service_type,
                            organization,
                            hours,
                            contact_phone,
                            contact_email,
                            contact_web,
                            notes,
                            submitted_at
                     FROM LocationSuggestion
                     WHERE status = 'pending'
                     ORDER BY submitted_at DESC
                     """)

        rows = cur2.fetchall()
        cur2.close()
        conn2.close()

        suggestions = [
            {
                "suggestion_id": r[0],
                "name": r[1],
                "address": r[2],
                "zip_code": r[3],
                "service_type": r[4],
                "organization": r[5],
                "hours": r[6],
                "contact_phone": r[7],
                "contact_email": r[8],
                "contact_web": r[9],
                "notes": r[10],
                "submitted_at": r[11]
            }
            for r in rows
        ]

        return render_template(
            "admin_location_suggestions.html",
            suggestions=suggestions,
            error_message=str(e)
        )

# if the admin rejects a suggestion, we will update the table and change the status to "rejected"
@app.route("/admin/location-suggestions/reject/<int:suggestion_id>")
def reject_location_suggestion(suggestion_id):
    role = session.get("role")
    if role != "admin":
        return render_template(
            "index.html"
        )

    conn = get_db_connection()
    cur = conn.cursor()

    cur.execute("""
        UPDATE freefoodmap.LocationSuggestion
        SET status = 'rejected'
        WHERE suggestion_id = %s
    """, (suggestion_id,))

    conn.commit()
    cur.close()
    conn.close()

    return redirect("/admin/location-suggestions")


# the admin also has access to see all orgs
@app.route("/admin/organizations")
def admin_organizations():
    role = session.get("role")
    if role != "admin":
        return render_template(
            "index.html"
        )

    conn = get_db_connection()
    cur = conn.cursor()

    cur.execute("""
        SELECT org_id, name
        FROM freefoodmap.Organization
        ORDER BY name;
    """)

    rows = cur.fetchall()
    cur.close()
    conn.close()

    organizations = [
        {"org_id": r[0], "name": r[1]}
        for r in rows
    ]

    return render_template("admin_organizations.html", organizations=organizations)

# the admin can add new orgs
@app.route("/admin/organizations/new", methods=["GET", "POST"])
def new_organization():
    role = session.get("role")
    if role != "admin":
        return render_template(
            "index.html"
        )

    if request.method == "POST":
        name = request.form["name"]

        conn = get_db_connection()
        cur = conn.cursor()

        cur.execute("""
            INSERT INTO freefoodmap.Organization (name)
            VALUES (%s)
        """, (name,))

        conn.commit()
        cur.close()
        conn.close()

        return redirect("/admin/organizations")

    return render_template("admin_organizations_new.html")


# or edit the name of an existing org
@app.route("/admin/organizations/edit/<int:org_id>", methods=["GET", "POST"])
def edit_organization(org_id):
    role = session.get("role")
    if role != "admin":
        return render_template(
            "index.html"
        )

    conn = get_db_connection()
    cur = conn.cursor()

    if request.method == "POST":
        new_name = request.form["name"]

        cur.execute("""
            UPDATE freefoodmap.Organization
            SET name = %s
            WHERE org_id = %s
        """, (new_name, org_id))

        conn.commit()
        cur.close()
        conn.close()

        return redirect("/admin/organizations")

    cur.execute("""
        SELECT org_id, name
        FROM freefoodmap.Organization
        WHERE org_id = %s
    """, (org_id,))

    row = cur.fetchone()
    cur.close()
    conn.close()


    org = {"org_id": row[0], "name": row[1]}

    return render_template("admin_organizations_edit.html", org=org)

# when the admin deletes an org, it will be removed from the database and the page will refresh
@app.route("/admin/organizations/delete/<int:org_id>")
def delete_organization(org_id):
    role = session.get("role")
    if role != "admin":
        return render_template(
            "index.html"
        )

    conn = get_db_connection()
    cur = conn.cursor()

    # we want to check if there are any locations associated with this org, because we don't want tp delete it if there are
    cur.execute("SELECT COUNT(*) FROM freefoodmap.Location WHERE org_id = %s", (org_id,))
    location_count = cur.fetchone()[0]

    # we also want to check if there are any users associated with this org, because we don't want to delete it if there are'
    cur.execute('SELECT COUNT(*) FROM freefoodmap.appuser WHERE org_id = %s', (org_id,))
    user_count = cur.fetchone()[0]

    if location_count > 0 or user_count > 0:
        error_msg = "Organization cannot be deleted because: "
        if location_count > 0:
            error_msg += "it has associated locations. "
        if user_count > 0:
            error_msg += "it has associated users."

        return render_template(
            "admin_organizations.html",
            error_message=error_msg,
            organizations=get_all_organizations()
        )

        # if the org exist by itself, we can delete it
    cur.execute("DELETE FROM freefoodmap.Organization WHERE org_id = %s", (org_id,))
    conn.commit()

    cur.close()
    conn.close()
    return redirect("/admin/organizations")

# a helper function to get all orgs from the database to be used when the admin is looking at the orgs
def get_all_organizations():
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT org_id, name FROM freefoodmap.Organization ORDER BY name;")
    orgs = cur.fetchall()
    cur.close()
    conn.close()
    return [{"org_id": r[0], "name": r[1]} for r in orgs]



# the admin can also create new events based on org and location
@app.route("/admin/events/new", methods=["GET", "POST"])
def admin_new_event():

    role = session.get("role")
    if role != "admin":
        return render_template(
            "index.html"
        )

    conn = get_db_connection()
    cur = conn.cursor()

    if request.method == "POST":
        event_type = request.form["type"]
        event_date = request.form["date"]
        org_id = request.form["org_id"]
        location_id = request.form["location_id"]

        cur.execute("""
            INSERT INTO freefoodmap.Event (type, date, org_id, location_id)
            VALUES (%s, %s, %s, %s)
        """, (event_type, event_date, org_id, location_id))

        conn.commit()
        cur.close()
        conn.close()

        return redirect("/admin/events")

    # this will give us a list of the orgs we have in the database so the admin can choose from them instead of inserting the name everytime (for convenience)
    cur.execute("SELECT org_id, name FROM freefoodmap.Organization ORDER BY name;")
    organizations = cur.fetchall()

    # same here but for locations
    cur.execute("SELECT location_id, name FROM freefoodmap.Location ORDER BY name;")
    locations = cur.fetchall()

    cur.close()
    conn.close()

    return render_template("admin_events_new.html",
                           organizations=organizations,
                           locations=locations)


# this is the dashboard that an org staff account will be able to see and access
@app.route("/org/dashboard")
def org_dashboard():

    role = session.get("role")
    if role != "Org Staff":
        return render_template(
            "index.html"
        )

    return render_template("org_dashboard.html", org_name=session.get("org_name", "Your Organization"))


# this is the dashboard that a volunteer account will be able to see and access
# volunteers can only see events and signup for them
@app.route("/volunteer")
def volunteer_dashboard():
    role = session.get("role")

    if role != "Volunteer":
        return render_template(
            "index.html"
        )

    user_id = session["user_id"]

    conn = get_db_connection()
    cur = conn.cursor()

    # this query will retrieve all the events
    cur.execute("""
        SELECT event_id, type, date
        FROM freefoodmap.Event
        WHERE date >= CURRENT_DATE
        ORDER BY date ASC;
    """)
    upcoming_events = cur.fetchall()

    # and this will give back the events the volunteer is signed up for
    cur.execute("""
        SELECT E.event_id, E.type, E.date
        FROM freefoodmap.Event E
        JOIN freefoodmap.VolunteerAt V ON E.event_id = V.event_id
        WHERE V.user_id = %s
        ORDER BY E.date ASC;
    """, (user_id,))
    my_events = cur.fetchall()

    cur.close()
    conn.close()

    return render_template(
        "volunteer_dashboard.html",
        upcoming_events=upcoming_events,
        my_events=my_events,
        username=session["username"]
    )

# this part will allow the org to see only the locations that are associated with their org
@app.route("/org/locations")
def org_locations():

    role = session.get("role")
    if role != "Org Staff":
        return render_template(
            "index.html"
        )

    org_id = session.get("org_id")

    conn = get_db_connection()
    cur = conn.cursor()

    cur.execute("""
        SELECT location_id, name, address, zip_code, service_type
        FROM freefoodmap.Location
        WHERE org_id = %s
        ORDER BY location_id;
    """, (org_id,))

    rows = cur.fetchall()
    cur.close()
    conn.close()

    locations = [
        {
            "location_id": r[0],
            "name": r[1],
            "address": r[2],
            "zip_code": r[3],
            "service_type": r[4],
        } for r in rows
    ]

    return render_template("org_location.html", locations=locations)

# this part will allow the org to see only the reports that are associated with location falls under their org
@app.route("/org/reports")
def org_reports():

    role = session.get("role")
    if role != "Org Staff":
        return render_template(
            "index.html"
        )

    org_id = session.get("org_id")

    conn = get_db_connection()
    cur = conn.cursor()

    cur.execute("""
        SELECT R.report_id, R.type, R.description, R.status, R.report_date,
               L.name AS location_name,
               U.username AS reported_by
        FROM freefoodmap.Report R
        JOIN freefoodmap.ocation L ON R.location_id = L.location_id
        JOIN freefoodmap.appuser U ON R.user_id = U.user_id
        WHERE L.org_id = %s
        ORDER BY R.report_date DESC;
    """, (org_id,))

    rows = cur.fetchall()
    cur.close()
    conn.close()

    reports = [
        {
            "report_id": r[0],
            "type": r[1],
            "description": r[2],
            "status": r[3],
            "report_date": r[4],
            "location_name": r[5],
            "reported_by": r[6]
        } for r in rows
    ]

    return render_template("admin_reports.html", reports=reports)

# this part will allow the org to see only the events that are associated with their org
@app.route("/org/events")
def org_events():

    role = session.get("role")
    if role != "Org Staff":
        return render_template(
            "index.html"
        )

    org_id = session.get("org_id")

    conn = get_db_connection()
    cur = conn.cursor()

    cur.execute("""
        SELECT event_id, type, date
        FROM freefoodmap.Event
        WHERE org_id = %s
        ORDER BY date DESC;
    """, (org_id,))

    rows = cur.fetchall()
    cur.close()
    conn.close()

    events = [
        {
            "event_id": r[0],
            "type": r[1],
            "date": r[2]
        } for r in rows
    ]

    return render_template("org_events.html", events=events)




# this part will store the information of the event and the volunteer at VolunteerAt table once they sign up for an event to keep track of who volunteered for which event
@app.route("/volunteer/signup/<int:event_id>", methods=["POST"])
def volunteer_signup(event_id):

    role = session.get("role")
    if role != "Volunteer":
        return render_template(
            "index.html"
        )

    user_id = session["user_id"]

    conn = get_db_connection()
    cur = conn.cursor()

    # we don't want to allow a volunteer to sign up for an event more than once
    cur.execute("""
        SELECT 1 FROM freefoodmap.VolunteerAt
        WHERE user_id = %s AND event_id = %s
    """, (user_id, event_id))

    exists = cur.fetchone()
    # once we make sure that the volunteer has not signed up for this event before, we will add them to the table
    if not exists:
        cur.execute("""
            INSERT INTO freefoodmap.VolunteerAt (user_id, event_id)
            VALUES (%s, %s)
        """, (user_id, event_id))
        conn.commit()

    cur.close()
    conn.close()

    return redirect("/volunteer")



# the admin also have access to see all the users that are created and exist this far
@app.route("/admin/users")
def admin_users():

    role = session.get("role")
    if role != "admin":
        return render_template(
            "index.html"
        )

    conn = get_db_connection()
    cur = conn.cursor()

    cur.execute("""
        SELECT user_id, username, email, role, org_id
        FROM freefoodmap.appuser
        WHERE role != 'admin'
        ORDER BY user_id;
    """)
    rows = cur.fetchall()
    cur.close()
    conn.close()

    users = [
        {
            "user_id": r[0],
            "username": r[1],
            "email": r[2],
            "role": r[3],
            "org_id": r[4]
        }
        for r in rows
    ]

    return render_template("admin_users.html", users=users)



# admin can edit the info of the user and change thir roles if needed
@app.route("/admin/users/edit/<int:user_id>", methods=["GET", "POST"])
def edit_user(user_id):

    role = session.get("role")
    if role != "admin":
        return render_template(
            "index.html"
        )

    conn = get_db_connection()
    cur = conn.cursor()

    if request.method == "POST":
        username = request.form["username"]
        email = request.form["email"]
        role = request.form["role"]
        org_id = request.form.get("org_id") or None

        cur.execute("""
            UPDATE freefoodmap.appuser
            SET username = %s,
                email = %s,
                role = %s,
                org_id = %s
            WHERE user_id = %s
        """, (username, email, role, org_id, user_id))

        conn.commit()
        cur.close()
        conn.close()

        return redirect("/admin/users")

    cur.execute("""
        SELECT user_id, username, email, role, org_id
        FROM freefoodmap.appuser
        WHERE user_id = %s
    """, (user_id,))
    u = cur.fetchone()

    cur.execute("SELECT org_id, name FROM freefoodmap.Organization ORDER BY name;")
    organizations = cur.fetchall()

    cur.close()
    conn.close()

    user = {
        "user_id": u[0],
        "username": u[1],
        "email": u[2],
        "role": u[3],
        "org_id": u[4],
    }

    return render_template("admin_users_edit.html", user=user, organizations=organizations)


# admin can also delete a user account
@app.route("/admin/users/delete/<int:user_id>")
def delete_user(user_id):

    role = session.get("role")
    if role != "admin":
        return render_template(
            "index.html"
        )

    conn = get_db_connection()
    cur = conn.cursor()

    cur.execute("DELETE FROM freefoodmap.appuser WHERE user_id = %s", (user_id,))
    conn.commit()

    cur.close()
    conn.close()

    return redirect("/admin/users")


# we created a view in our database to be used for this part
# we want public users to be able to all the locations that already exist in our database and search them using zipcode number
@app.route("/search-zip")
def search_zip():
    zipcode = request.args.get("zipcode")

    if not zipcode or not zipcode.isdigit() or len(zipcode) != 5:
        return render_template(
            "public_map.html",
            error_message="Please enter a valid 5-digit ZIP code.",
            locations=None,
            zipcode=None
        )

    conn = get_db_connection()
    cur = conn.cursor()

    # showing the public users all the locations that are associated with the zipcode they searched for
    cur.execute("""
                SELECT location_id,
                       location_name,
                       address,
                       zip_code,
                       service_type,
                       hours,
                       contact_phone,
                       contact_email,
                       contact_web,
                       notes,
                       organization_name,
                       next_event_date,
                       has_event
                FROM freefoodmap.ZipcodeLocationView
                WHERE zip_code = %s
                ORDER BY location_name;
                """, (zipcode,))

    rows = cur.fetchall()
    cur.close()
    conn.close()

    locations = [
        {
            "location_id": r[0],
            "location_name": r[1],
            "address": r[2],
            "zip_code": r[3],
            "service_type": r[4],
            "hours": r[5],
            "contact_phone": r[6],
            "contact_email": r[7],
            "contact_web": r[8],
            "notes": r[9],
            "organization_name": r[10],
            "next_event_date": r[11],
            "has_event": r[12]
        }
        for r in rows
    ]

    return render_template(
        "public_map.html",
        locations=locations,
        zipcode=zipcode
    )


if __name__ == "__main__":
    app.run(debug=True)


