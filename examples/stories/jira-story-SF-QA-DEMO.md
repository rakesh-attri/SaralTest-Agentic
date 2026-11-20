# JIRA story (copy into a new Story in your JIRA project)

**Summary:** Sales Reps can add validated Contacts to an Account

**Issue type:** Story · **Priority:** High · **Components:** Contacts, Accounts · **Labels:** sf-qa-demo, contacts

**Description**

As a Sales Rep, I want to add Contacts directly from an Account record, so that every customer contact is tracked against the right company with clean, usable details.

Contacts are created from the Contacts related list on the Account page (Lightning). The new Contact must be linked to that Account automatically. Mailing address should probably default from the Account.

**Acceptance criteria**

AC1 – Create from Account
Given I am a Sales Rep viewing an Account
When I click New in the Contacts related list and enter First Name, Last Name, Email, Phone and Title, and click Save
Then the Contact is created and its Account Name is the Account I started from

AC2 – Last Name is required
Given I am creating a Contact
When I leave Last Name empty and click Save
Then the Contact is not saved and an error is shown on the Last Name field

AC3 – Email format
Given I am creating a Contact
When I enter an Email that is not a valid email address
Then the Contact is not saved and an error is shown

AC4 – Duplicate warning
Given a Contact with the same Email already exists on this Account
When I save a new Contact with that Email
Then I am warned that a possible duplicate exists

AC5 – Phone format
Given I enter a Phone number
When it is not 10 digits
Then the Contact is not saved and an error is shown

AC6 – Read-only users
Given I am a Read Only user
When I open an Account
Then I cannot create or edit Contacts

AC7 – Related list updates
Given I created a Contact from an Account
When I return to the Account
Then the new Contact appears in the Contacts related list

**Out of scope:** Contact import, Contact merge, Lead conversion.
