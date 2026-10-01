// The Global Administrator Manual, step by step. Screenshots: docs/manuals/screens/global-*.jpg, made by
// screenshots.cjs from the local global console with demo data only. Rebuild: node docs/manuals/build-manuals.cjs
module.exports = {
  file: "FileBank-WorkFlow-Global-Administrator-Manual.pdf",
  title: "Global Administrator Manual",
  subtitle: "Step-by-step instructions for creating and looking after the customer organisations on an installation",
  audience:
    "This manual is for the people who run a FileBank WorkFlow installation for more than one organisation. Each task is a short list of steps with a picture of the screen; the button or box a step talks about is outlined in red. The pictures show demonstration customers such as Riverside Academy. Server installation is in docs/DEPLOYMENT-IIS.md; what a customer administrator does inside their own organisation is in the Administrator Manual.",
  version: "2.0",
  date: "October 2026",
  blocks: [
    // ---------------------------------------------------------------------------------------------
    { h1: "How it works" },
    { p: "One installation hosts many **customers** (organisations). Each has its own address, forms, people and data, and none can see any other. The **global management console** is where customers are created and looked after. It is a separate site with a separate sign-in: your account there is not a user in any customer, and no customer administrator can see it, deactivate it or reset its key." },
    { table: { widths: [0.3, 0.7], head: ["Role", "What it can do"], rows: [
      ["Global administrator (you)", "Create customers, rename them, move them to another address, suspend, restore and remove them, add or remove a customer's administrators, reset an administrator's key, change a customer's settings, choose a folder for its files, export its PDFs, start a time-limited support session, and look after the other global administrators."],
      ["Customer administrator", "Everything inside one organisation: forms, approval chains, lookups, requests, its own people and settings. Nothing outside it."],
    ] } },
    { note: "You cannot read a customer's requests, forms or documents from the console. When you genuinely need to see what a customer sees, use a **support session**, which is visible to them and recorded in their own audit log." },

    // ---------------------------------------------------------------------------------------------
    { h1: "Getting started" },
    { task: "Sign in to the console",
      need: "a global administrator account.",
      steps: [
        { text: "Open **/global** on the installation address (for example https://vwf.filebankinc.com/global). Type your **email address** and **6-digit password key** and choose **Sign in**.", img: "screens/global-01-sign-in.jpg", maxH: 260 },
      ],
      result: "The customer list opens. The console always has a **navy** top bar, where customer portals have a black one - so you can tell at a glance where you are.",
      trouble: [
        "Five wrong keys lock the account for 15 minutes.",
        "**Help** (top right) opens this manual; a copied link to it stops working after a few minutes.",
      ] },
    { task: "Create the very first global administrator",
      need: "access to the server - there is nobody yet who could do it in the console.",
      steps: [
        "On the server run: npm run seed:platform-admin -- --email you@example.com --displayName \"Your Name\"",
        "A random 6-digit key is printed **once**. Sign in with it, then change it (**Administrators > Change my key**).",
      ],
      trouble: "Run it again with --reset-key for somebody who has lost their key and cannot be helped by another global administrator." },

    // ---------------------------------------------------------------------------------------------
    { h1: "Customers" },
    { task: "Check on all customers",
      steps: [
        { text: "The console opens on **Customers**. The tiles count active customers, people, requests in progress and **failed emails** across all customers - a quick check that nothing is stuck anywhere.", img: "screens/global-02-customers.jpg", maxH: 240 },
        "Click a customer's name to open its page, or **Open** to open its portal's sign-in page in a new tab.",
      ] },
    { table: { widths: [0.24, 0.76], head: ["Column", "Meaning"], rows: [
      ["Customer", "The organisation's name. **Suspended** means nobody there can sign in; **Removed** shows the date its data will be deleted."],
      ["Address", "The short name its site is reached at."],
      ["People / Forms", "Active user accounts / active forms."],
      ["Requests", "Total requests, and how many are still open."],
      ["Last activity", "The most recent audited event there. A customer with no activity for a long time is worth asking about."],
    ] } },
    { p: "**Recent management activity** below the list shows the last 20 things global administrators did, and who. It comes from the platform audit log, which records every action in the console and can never be changed." },
    { task: "Create a customer",
      need: "the organisation's name and the email and name of the person who will set it up.",
      steps: [
        "On **Customers** choose **New customer**.",
        { text: "Type the **Organisation name**. The **Address** (short name) is filled in for you - lowercase letters, digits and hyphens; choose carefully, because changing it later changes what people have bookmarked. Fill **Full host name** only for a name of the customer's own such as approvals.acme.com. Type the **First administrator's email** and **name**. Optionally type a **Folder for this customer's files**.", img: "screens/global-03-new-customer.jpg", maxH: 330 },
        "Choose **Create customer**.",
      ],
      result: "The organisation, its numbering, its settings and its first administrator are created together. A **first sign-in key** is shown **once**: pass it to the administrator through a channel you trust, separately from the address. They sign in, change the key, set their branding on **Settings**, build their forms and tell their colleagues the address.",
      trouble: [
        "An address or host name that is already taken is refused.",
        "A lost first key: use **Reset key** on the customer's page rather than creating a second customer.",
      ] },
    { task: "Rename a customer or change its address",
      steps: [
        { text: "Open the customer. Under **Address and status** change the **Organisation name**, the **Host name** or the **Notification address** (where alerts go when nobody more specific applies; blank means every administrator). Choose **Save**.", img: "screens/global-04-address.jpg", maxH: 280 },
      ],
      trouble: "A new host name works only once DNS points that name at this installation (and, for a name of its own, a certificate and IIS binding exist). Arrange that first, or people will find nothing there." },
    { task: "Suspend or reactivate a customer",
      steps: [
        "Open the customer. Under **Address and status** choose **Suspend this customer**, then **Yes, suspend it**.",
        "To undo it, choose **Reactivate**.",
      ],
      result: "Suspended: nobody can sign in, everybody signed in is signed out within moments, and scheduled reminders stop. Nothing is deleted; **Reactivate** puts everything back exactly as it was. Use it for non-payment, an offboarding or a security incident." },
    { task: "Remove a customer that has left",
      need: "a suspended customer.",
      steps: [
        "Open the customer. In **Remove this customer** at the bottom, type the customer's short address name exactly as shown.",
        "Choose **Remove customer**.",
      ],
      result: "The customer is frozen for **30 days** and the list shows the date its data will be deleted. Then everything it owns is deleted for good: people, forms, requests and decisions, lookups, settings, its audit log, PDFs and emails, and the files the app wrote to its folder.",
      trouble: [
        "To undo it, open the customer and choose **Restore this customer** before that date. It comes back suspended; choose **Reactivate** when its people may sign in again.",
        "Export anything the customer may want before the date - after it the deletion cannot be undone. The grace period is set on the server with TENANT_REMOVAL_DAYS.",
      ] },

    // ---------------------------------------------------------------------------------------------
    { h1: "Looking after a customer" },
    { task: "Add an administrator to a customer",
      steps: [
        { text: "Open the customer. Under **Administrators**, in **Add an administrator**, type the **Email** - and the **Full name** if the person has no account there yet. Choose **Add administrator**.", img: "screens/global-06-administrators.jpg", maxH: 280 },
      ],
      result: "Someone with an account gets the Admin role and keeps their other roles; someone deactivated is reactivated with it. Someone new gets an account with no key and an email **\"Your account for <organisation>\"**; at their first sign-in they confirm the address with a code and choose their own key. They show **Not set yet** under Key until then. Recorded in the console's audit log and the customer's own.",
      trouble: "Any address is accepted, even outside the customer's allowed email domains (for example an outside consultant): that setting only limits people registering themselves." },
    { task: "Remove an administrator, or reset their key",
      steps: [
        "Open the customer. In the **Administrators** list choose **Remove** to take the Admin role away (the account stays, with its other roles).",
        "Or choose **Reset key**, then **Yes, reset it**: their key stops working, and at their next sign-in they prove their email with a code and choose a new one. You never see either key.",
      ],
      trouble: "Never leave an organisation with no administrator - its people would be locked out of their own configuration until you grant the role again." },
    { task: "Export a customer's PDFs",
      steps: [
        { text: "Open the customer. Under **Export PDFs** choose the **Form**, the **Submitted from** and **to** dates and the **Outcome**, then **Check**: it shows how many PDFs match and the ZIP's name.", img: "screens/global-07-export.jpg", maxH: 230 },
        "Choose **Download ZIP**.",
      ],
      result: "A ZIP of every PDF under its usual name plus **Index.xlsx** - one row per PDF with a link to it, the request's details, its approval steps and the form's fields. It is the same export the customer's administrators have under Requests. Recorded as **tenant.pdfs_exported** in the console and **pdf.exported** (with your email as changedBy) in the customer's log.",
      trouble: "At most **500 PDFs** at a time - narrow the dates for more." },
    { task: "Keep a customer's files in a folder of its own",
      need: "a folder on a drive of the server or a network share, with **Modify** permission for the Windows account the app runs as (and on the share).",
      steps: [
        { text: "Open the customer. Under **File storage** type the full path - **D:\\CustomerFiles\\Acme** (not a whole drive) or **\\\\fileserver\\approvals\\Acme** - and choose **Use this folder**.", img: "screens/global-05-file-storage.jpg", maxH: 250 },
      ],
      result: "The app proves it can write there before saving. From now on the customer's PDFs and approvers' documents are saved there, **one sub-folder per day submitted** (2026-09-28); documents are named after their request and step (REQ-000014_Step-1_Supplier quote.pdf). Nothing is ever overwritten, and the customer never sees the path.",
      trouble: [
        "If the app cannot write there it says why and nothing changes.",
        "Only **new** files go there; older files stay where they are and still open. **Keep new files in the database instead** switches back the same way.",
        "The app keeps each file's fingerprint and refuses one changed or removed outside it - back the folder up, and restore from the backup if that happens.",
      ] },
    { task: "Change a customer's settings",
      steps: [
        "Open the customer and scroll to **Settings**: branding, who may register and the email sender - exactly as their own administrator sees it.",
        "Make the change and choose **Save settings**.",
      ],
      result: "The change is recorded in the customer's audit log with your email beside it, so nothing you do there is invisible to them." },
    { task: "Help a customer with a support session",
      need: "an active customer and a reason - a ticket number is ideal.",
      steps: [
        { text: "Open the customer. Under **Support access** type **Why** and choose **Start support session**.", img: "screens/global-08-support.jpg", maxH: 230 },
        "Choose **Open the portal**. Their portal opens as one of their administrators, with a banner for the whole session.",
      ],
      result: "The session lasts **30 minutes** and can do no more than that administrator could. Its start and reason are recorded as **user.impersonation_started**, and everything done during it is stamped **impersonatedByPlatformAdmin** in their audit log.",
      trouble: "A suspended customer cannot be opened. Treat a session like remote control of somebody's desk: do what was asked and nothing else, and prefer the console's Settings for configuration changes." },
    { task: "Add the sample forms to a customer",
      need: "a customer with an administrator and at least one approver.",
      steps: [
        "On the server run: npm --prefix server run sample:forms -- --tenant <address name> (for example --tenant acme).",
      ],
      result: "Five sample forms with approval chains are added - Leave Request, Mileage Reimbursement, IT Access & Equipment Request, Records Retrieval Request and Secure Destruction Authorization - using the customer's own approvers and its Departments and Schools lookup tables if it has them. A form that already exists is left alone." },

    // ---------------------------------------------------------------------------------------------
    { h1: "Global administrators" },
    { task: "Add a global administrator",
      steps: [
        { text: "Choose **Administrators** in the top bar, then **New global administrator**. Type their **email address** and **name**.", img: "screens/global-09-admins.jpg", maxH: 210 },
        "A 6-digit key is generated and shown **once**. Pass it to them through a channel you trust; they change it after signing in.",
      ],
      trouble: "A global administrator can create, change, suspend and remove every customer. Add only people who need that, and give each person their own account." },
    { task: "Look after the other global administrators",
      steps: [
        "On **Administrators** choose **New key** for somebody who has lost theirs (shown once; the old key stops working).",
        "Choose **Deactivate** when somebody leaves - they are blocked at once and any open session ends. **Reactivate** lets them back.",
        "Use **Change my key** for your own key: the current key and the new one twice.",
      ],
      result: "Every change is in the platform audit log with who made it. Nobody can deactivate themselves or give themselves a new key here, so there is always at least one active global administrator." },

    // ---------------------------------------------------------------------------------------------
    { h1: "Reference" },
    { h2: "How an address decides the organisation" },
    { p: "The address in the browser decides which organisation a request belongs to. A person in two customers has **two separate accounts** with separate keys; a key from one never works at the other address. Every link in every email uses the organisation's own address." },
    { p: "With a wildcard DNS record and certificate (see docs/DEPLOYMENT-IIS.md), a new customer needs **no server work** - creating it in the console is enough. A customer with a name of its own needs a DNS entry, a certificate and an IIS binding, then its **Host name** set on its page." },
    { h2: "What is shared and what is not" },
    { table: { widths: [0.42, 0.58], head: ["Kept apart per customer", "Shared by the installation"], rows: [
      ["Forms, requests, documents, lookups, users, audit log", "The server, the database and the mail server"],
      ["Branding, sign-up rules, sender address", "The default values those settings fall back to"],
      ["Archived PDFs and documents (database or the customer's folder)", "The database, or the server or share holding the folders"],
    ] } },
    { p: "Separation is enforced in the database itself: every table carries the organisation, child rows can only point at a parent in the same organisation, and a query that does not say which organisation it means is rejected." },
    { h2: "Everyday tasks" },
    { table: { widths: [0.38, 0.62], head: ["Situation", "What to do"], rows: [
      ["A new customer is joining", "**Create a customer**; send the address and the first key separately; point their administrator to the Administrator Manual."],
      ["The first administrator lost the key", "Open the customer, **Reset key** beside them."],
      ["Their administrator has left", "**Add an administrator** for the replacement, then **Remove** the old one."],
      ["Emails are not arriving", "Check **Failed emails** on the customer list, then the customer's sender address in Settings. The mail server itself is installation-wide."],
      ["They report something you cannot see", "Ask for the request number and start a **support session** with it as the reason."],
      ["Non-payment or an incident", "**Suspend** the customer. Nothing is deleted."],
      ["A customer has left for good", "Suspend it, then **Remove customer**. Restorable for 30 days."],
      ["Somebody asks what you did in their organisation", "Their own audit log has every action of yours; support-session actions are stamped as such."],
      ["A customer wants its files on its own drive", "Give the app's account Modify permission, then set **File storage** on its page."],
    ] } },
    { h2: "Keeping your own account safe" },
    { ul: [
      "Your account can create, suspend and enter every organisation, so use a key nobody else knows and that you use nowhere else.",
      "Sign out when you are finished, particularly on a shared machine. A support session ends on its own; your console session does not.",
      "Never share a global administrator account - the platform audit log is only useful if it names a person.",
    ] },
  ],
};
