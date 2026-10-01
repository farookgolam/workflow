// The User Manual, step by step. Screenshots: docs/manuals/screens/user-*.jpg, made by screenshots.cjs from the
// local demo organisation "Riverside Academy" (never from real data). Rebuild: node docs/manuals/build-manuals.cjs
module.exports = {
  file: "FileBank-WorkFlow-User-Manual.pdf",
  title: "User Manual",
  subtitle: "Step-by-step instructions for people who submit requests and people who approve them",
  audience:
    "Each task in this manual is a short list of steps with a picture of the screen; the button or box a step talks about is outlined in red. Look up what you want to do in the contents and follow the steps. The pictures show a demonstration organisation, Riverside Academy, with made-up people such as Sam Submitter and Maria Manager - your organisation's name, logo, forms and people will be your own. Administrators have a separate manual.",
  version: "2.0",
  date: "October 2026",
  blocks: [
    // ---------------------------------------------------------------------------------------------
    { h1: "How it works" },
    { p: "FileBank WorkFlow moves a request through a series of approval steps. Each form has its own chain of approvers, set up by your administrator." },
    { ol: [
      "A **submitter** fills in a form and submits it. The request gets a number such as **REQ-000123**.",
      "The approver of **step 1** is emailed. They open the request and choose **Approve**, **Send back for changes** or **Reject**.",
      "Each approval moves the request to the next step, until the last one. Then it is **Approved**: a PDF of the whole record is made and the submitter is emailed.",
      "**Send back** returns the request to the submitter to fix; when they resubmit, it goes straight back to the same step. **Reject** ends the request for good.",
    ] },
    { table: { widths: [0.22, 0.78], head: ["Your role", "What you can do"], rows: [
      ["Submitter", "Submit forms, follow your own requests, make changes when one is sent back, download the PDF."],
      ["Approver", "Decide on the steps sent to you: approve (with your signature), send back or reject."],
      ["Administrator", "Set up forms, people and settings (see the Administrator Manual)."],
    ] } },
    { p: "One person can have several roles; the home page then shows a section for each. Under **Help** (top right) you can also open **How a request works (workflow)**: the whole process on two pages." },

    // ---------------------------------------------------------------------------------------------
    { h1: "Getting started" },
    { task: "Sign in for the first time",
      need: "the address of your organisation's site (for example https://acme.vwf.filebankinc.com) and access to your work email.",
      steps: [
        { text: "Open your organisation's address. Type your **work email** and choose **Continue**.", img: "screens/user-01-sign-in.jpg", maxH: 230 },
        { text: "A **6-digit code** is emailed to you (valid for 10 minutes). Type the code, your **full name**, and a **6-digit password key** of your own choice twice, then choose **Create key and sign in**.", img: "screens/user-03-first-time.jpg", maxH: 230 },
      ],
      result: "You are signed in and see your home page. From now on you sign in with your email and your key.",
      trouble: [
        "No email? Look in your junk folder. Choose **change**, enter your email again and **Continue** for a new code (after a minute).",
        "The key must be exactly six digits; obvious keys such as 123456 or 111111 are refused.",
        "\"Only your organisation's email addresses can be used here\": use your work address.",
      ] },
    { task: "Sign in",
      steps: [
        "Open your organisation's address, type your work email and choose **Continue**.",
        { text: "Type your **6-digit password key** and choose **Sign in**.", img: "screens/user-02-key.jpg", maxH: 230 },
      ],
      result: "Your home page opens. You stay signed in when you reload the page; choose **Sign out** (top right) on a shared computer.",
      trouble: [
        "After **5 wrong keys** the account is locked for 15 minutes - wait, or use **Forgot your key?** below the key box.",
        "Forgotten your key: choose **Forgot your key?**, enter the emailed code and choose a new key.",
      ] },
    { task: "Find your way around",
      steps: [
        { text: "Your **home page** shows what you can do: **Start a new request** (the forms you can fill in), **My submissions** (your requests) and, for approvers, **Waiting for my approval**.", img: "screens/user-04-home.jpg" },
        { text: "Top right: **Help** opens the manuals and the workflow sheet; the small screen icon switches **light / dark** colours; **your name** opens your account (password key and approval emails).", img: "screens/user-05-help.jpg", width: 0.7 },
      ] },
    { task: "See the version, or contact FileBank",
      steps: [
        { text: "Choose **Help** at the top right, then **About FileBank WorkFlow**.", img: "screens/user-23-about-menu.jpg", width: 0.6 },
        { text: "The window shows the application's **version**, when it was **last updated**, and how to reach FileBank: **filebankinc.com** and **973-279-4411** (both can be clicked; on a phone the number calls). Choose **Close**.", img: "screens/user-24-about.jpg", width: 0.55 },
      ],
      result: "Mention the version when you report a problem - it tells support exactly what you are using." },
    { task: "Change your password key",
      steps: [
        "Click **your name** at the top right.",
        "Under **Change password key** type your current key and the new key twice, then choose **Change key**.",
      ],
      result: "Your new key works at once; your other devices are signed out." },

    // ---------------------------------------------------------------------------------------------
    { h1: "Submitting requests" },
    { task: "Submit a request",
      need: "the Submitter role.",
      steps: [
        "On your home page, under **Start a new request**, click the form you need (see the picture under \"Find your way around\").",
        { text: "Fill in the fields. Fields marked with a red **\\*** are required. Some forms ask you to choose **who approves it first** in a **Send to** box at the bottom.", img: "screens/user-06-new-request.jpg" },
        "Choose **Submit for approval**.",
      ],
      result: "The request page opens with a green confirmation, and the first approver is emailed. You receive a \"We received your request\" email.",
      trouble: [
        "If something is missing or wrong, nothing is submitted: the fields are highlighted with a message. Correct them and submit again.",
        "Sent something by mistake? Ask an administrator to cancel it - you cannot withdraw it yourself.",
      ] },
    { task: "Follow your requests",
      steps: [
        { text: "Your home page lists **My submissions**, newest first, with anything sent back to you at the top. The coloured bars show each step: **green** approved, **amber** waiting now, **purple** sent back to you, **red** rejected, **grey** not reached yet. The buttons at the top filter the list.", img: "screens/user-07-my-submissions.jpg" },
        { text: "Click a request number to open it. **Progress** shows every step: who decided and when, or who has it now and for how long.", img: "screens/user-08-progress.jpg", maxH: 260 },
      ] },
    { task: "Make changes when a request is sent back",
      need: "a request an approver sent back to you (you receive a \"Changes needed\" email).",
      steps: [
        { text: "Open the request (from the email, or **Needs my changes** on your home page). The purple box says who sent it back and what to change. Choose **Make the changes**.", img: "screens/user-09-sent-back.jpg", maxH: 200 },
        { text: "The form opens with your answers filled in. Change what was asked. A drawn signature is not carried over: sign again. Optionally add a **note** for the approver. Choose **Resubmit to ...**.", img: "screens/user-10-resubmit.jpg" },
      ],
      result: "The request goes straight back to the approver who sent it back; they are emailed a list of exactly what you changed. Earlier approvals stay approved." },
    { task: "When a request is rejected",
      steps: [
        { text: "You receive an email with the **reason**; the request page shows it in a red box with the step, the approver and the date.", img: "screens/user-11-rejected.jpg", maxH: 170 },
        "Rejection is **final**. To try again, choose **start a new request using these details**: a new form opens with your answers filled in.",
      ] },
    { task: "Download the PDF",
      need: "a finished (approved or rejected) request.",
      steps: [
        { text: "Open the request and choose **Download final PDF** (or **Archived PDF** for a rejected one). The list on your home page has the same link.", img: "screens/user-12-pdf.jpg", maxH: 250 },
      ],
      result: "The PDF has your submission, every decision with the approver's signature, and a summary of what happened. Its name is the form name, the request number and the date it was submitted, for example **Purchase-R_000123_01102026.pdf**.",
      trouble: "\"The PDF is being prepared\": it is made within a minute of the decision. Refresh the page." },
    { h2: "Emails you will receive" },
    { table: { widths: [0.42, 0.58], head: ["Email", "When"], rows: [
      ["We received your ... request", "Right after you submit."],
      ["Changes needed: your ... request", "An approver sent it back; it says what to change and has a **Make the changes** button."],
      ["Your ... request is fully approved", "The last approver approved it."],
      ["Your ... request was rejected", "Any approver rejected it, with the reason."],
      ["Your ... request was cancelled", "An administrator cancelled it, with their reason."],
    ] } },

    // ---------------------------------------------------------------------------------------------
    { h1: "Approving requests" },
    { task: "Open a request from the approval email",
      need: "the Approver role.",
      steps: [
        { text: "When a request reaches your step you receive **Approval needed: ...** with the request's details and three buttons: **Approve**, **Send back for changes** and **Reject**. Choose one, or **Open the full request**.", img: "screens/user-13-email.jpg", width: 0.75 },
        "Sign in if asked. The request opens ready for the choice you made; nothing is decided until you confirm on the page.",
      ],
      trouble: [
        "The link is **personal**: it only works for your account. Forwarding it does not let a colleague act - ask an administrator to reassign the step or add a delegate.",
        "\"This link can't be used\": it expired (after 14 days) or was replaced by a newer email. Use **Waiting for my approval** on your home page instead.",
      ] },
    { task: "Find what is waiting for you",
      steps: [
        { text: "Your home page lists **Waiting for my approval**, oldest first, with how long each has waited; **Overdue** marks one past its reminder time. Click a request number to open it.", img: "screens/user-14-waiting.jpg", maxH: 220 },
      ] },
    { task: "Review a request",
      steps: [
        { text: "The approval page shows the **original submission** (read-only) at the top. Read it before you decide.", img: "screens/user-15-approval-page.jpg" },
        { text: "From step 2 on, **Previous approvals** shows each earlier step: who decided, when, their comments, their signature and any documents they attached. You never see later steps.", img: "screens/user-21-previous.jpg", maxH: 260 },
      ] },
    { task: "Approve a request",
      steps: [
        "In **Your section**, keep **Approve** selected.",
        "Add **Comments** if you wish, and attach supporting documents under **Attach documents** (optional; PDF, Office files, text or images, up to 10 MB each - only approvers and administrators can see them).",
        { text: "**Sign** in the **Your signature** box with your finger, a stylus or the mouse (**Undo** removes the last stroke, **Clear** starts again). If a **Send to** box shows a list, choose who approves the next step. Then choose **Approve** (or **Approve and send on**).", img: "screens/user-16-approve.jpg" },
      ],
      result: "A green message says the request moved to the next step - whose approver is emailed - or, on the last step, that it is fully approved. Your section is now read-only.",
      trouble: [
        "\"Sign to approve\": draw your signature first.",
        "\"This step has already been completed\": you (in another tab) or a delegate decided it already. Refresh the page.",
      ] },
    { task: "Send a request back for changes",
      steps: [
        { text: "In **Your section** choose **Send back for changes**, type in **What needs to change?** what the submitter should do (required - they see it word for word), then choose **Send back to ...**. No signature is needed.", img: "screens/user-17-send-back.jpg", maxH: 230 },
      ],
      result: "The request leaves your list. When the submitter resubmits, it comes back to you with a \"Resubmitted for approval\" email and a purple box listing exactly what they changed. Earlier approvals stay." },
    { task: "Reject a request",
      steps: [
        { text: "In **Your section** choose **Reject**, type the **reason for rejection** (required - it is sent to the submitter word for word) and choose **Confirm rejection**. No signature is needed.", img: "screens/user-18-reject.jpg", maxH: 230 },
      ],
      result: "The request stops for good, the submitter and the administrators are emailed, and a PDF marked REJECTED is kept. If the request only needs fixing, send it back instead." },
    { task: "Approve several requests at once",
      need: "two or more requests waiting for you.",
      steps: [
        { text: "Under **Waiting for my approval**, tick the requests (or **Select all**) and choose **Approve selected**.", img: "screens/user-19-batch.jpg", maxH: 220 },
        { text: "Check each request's details in the panel; **Remove** takes one out. If a **Send to** box appears under a request, choose who approves next (**Send the other ... too** copies your choice). Optionally add a **Comment for all of them** or **Add a comment for this request**. **Sign** once and choose **Approve N requests**.", img: "screens/user-20-batch-panel.jpg" },
      ],
      result: "A list shows each request: approved and moved on, fully approved, or not approved with the reason (the others are not affected). Your signature is saved with each one.",
      trouble: "Only approving works in a batch. To send back or reject, open the request. At most 50 at a time." },
    { task: "Get one summary email a day instead",
      steps: [
        "Click **your name** at the top right.",
        { text: "Under **Approval emails** choose **Send me one summary a day instead**, then pick the hour in **Send it at** (your own time zone is shown under it).", img: "screens/user-22-account.jpg", maxH: 250 },
      ],
      result: "Monday to Friday at that hour you get one email listing everything waiting for you - only when something is - instead of an email per request. Choose **Email me about each request as it arrives** to switch back. An administrator's own reminder still reaches you straight away." },
    { h2: "Reminders, reassignment and delegates" },
    { ul: [
      "If the form has reminder rules, you receive **Reminder: approval needed** after the set number of days (not with the daily summary - it reminds you every weekday).",
      "An administrator can **reassign** your step to someone else, or add a **delegate** who can act as well as you. Whoever decides first is recorded.",
      "Going on leave? Ask an administrator to add a delegate or reassign your open steps.",
    ] },

    // ---------------------------------------------------------------------------------------------
    { h1: "Reference and troubleshooting" },
    { h2: "Request statuses" },
    { table: { widths: [0.22, 0.78], head: ["Status", "Meaning"], rows: [
      ["In progress", "Waiting for the approver of the current step - or, marked **Sent back**, waiting for the submitter's changes."],
      ["Approved", "Every step approved. Final. PDF available."],
      ["Rejected", "Rejected at one step. Final. Reason shown; PDF available."],
      ["Cancelled", "Stopped by an administrator before completion. Final."],
    ] } },
    { h2: "Step statuses" },
    { table: { widths: [0.22, 0.78], head: ["Status", "Meaning"], rows: [
      ["Waiting", "Earlier steps are not finished yet."],
      ["Active", "Waiting for this approver now."],
      ["Sent back", "This approver sent the request back for changes. It becomes Active again when the submitter resubmits."],
      ["Approved / Rejected", "Decided. The section is locked."],
      ["Not reached", "An earlier step rejected the request, so this step never started."],
      ["Cancelled", "The request was cancelled before this step was decided."],
    ] } },
    { h2: "Common messages" },
    { table: { widths: [0.42, 0.58], head: ["Message", "What to do"], rows: [
      ["Incorrect email or password key", "Check your email address and key. After 5 wrong attempts the account locks for 15 minutes. Forgotten the key? Use **Forgot your key?** on the sign-in page."],
      ["That code is not right / This code has expired", "Use the code from the **latest** email. After 5 wrong attempts or 10 minutes, go back and continue again for a new code."],
      ["This account already has a password key", "You are already set up: sign in with your key, or use **Forgot your key?**"],
      ["This link can't be used", "The approval link expired, was replaced by a newer one, the step was reassigned, or you are signed in as someone else. Check **Waiting for my approval**, or ask an administrator for a reminder."],
      ["This approval does not exist or is not assigned to you", "The step belongs to someone else. Make sure you are signed in with the right account."],
      ["Sign to approve", "Draw your signature in the **Your signature** box, then choose **Approve** again."],
      ["Say what needs to change", "Sending back needs a message for the submitter. Type it in **What needs to change?**"],
      ["This request has not been sent back to you, so it cannot be changed", "It was already resubmitted (perhaps in another tab), or an administrator cancelled it. Open the request to see where it is."],
      ["This step has already been completed", "It was decided already (by you in another tab, or by a delegate). Refresh to see the result."],
      ["This request is rejected / cancelled and can no longer be changed", "The request closed while you had it open. No action is needed."],
      ["Request not found", "The request is not yours, or the number is wrong. Submitters can open only their own requests."],
      ["The PDF has not been generated yet", "Wait a minute and try again."],
      ["Too many attempts. Please wait a minute.", "Sign-in attempts are limited. Wait one minute."],
      ["A new version of FileBank WorkFlow is available", "The system was updated while your page was open. Choose **Reload** (anything typed on this page is lost), or carry on: the next page you open loads the new version by itself."],
    ] } },
    { h2: "Good practice" },
    { ul: [
      "Never share your password key or codes, and do not forward approval links. Every decision is recorded against your account.",
      "Write reasons, send-back messages and comments carefully: they become part of the permanent PDF record.",
      "Prefer **Send back for changes** over rejecting when a request can be fixed: the submitter does not have to start again.",
      "Decide promptly. Waiting requests show to administrators as overdue.",
    ] },
  ],
};
