---
name: ui-implement
description: Implement or improve UI components and their documentation, examples and tests, then deliver Git work for integration.
---
# UI implementation and delivery
Input: dedicated worktree at exact baseCommit, task, approved product direction, platform, jobId, outputDir, acceptance criteria and authorized delivery scope.
1. Read onboarding and product conventions. Check existing components/compositions first; document reuse vs extension vs new component.
2. Confirm isolated worktree/base SHA and host ownership. Do not create a second writer. Escalate scope/contract conflicts rather than silently change approved direction.
3. Implement code, semantic tokens/variants as needed, API/events/usage/composition/misuse documentation, catalog examples and appropriate tests together. Cover applicable loading/empty/error/disabled/focus/success states, responsive layout, text scaling, localization and realistic content.
4. Run only approved setup/checks and inspect rendered results where supported. Record commands, exit status, environment and exact candidate SHA. Do not replace native verification with a web preview or fabricate unavailable behavior.
5. Commit a candidate locally, then request a fresh ui-evaluate review with neutral purpose/task/platform/approved direction and source/evidence references, never implementation reasoning/self-ratings. Independent review is against that candidate SHA.
6. Proposed acceptance: overall >=4/5, each inspected dimension >=3/5, required checks pass, no blockers. Missing required evidence means partial verification. Unless the task sets an approved alternative, use this proposed threshold but label it proposed, not user-approved. At most two revision rounds after initial review, within the host timeout. Preserve every review; escalate rather than declare success when the budget expires.
7. Deliver only within authorized job-branch scope. The host performs credentialed pushes and validates branch/ref. Never merge, force-push unrelated refs, deploy or discard undelivered work. Agent shell access is not an enforced Git boundary.
Output: <outputDir>/delivery.md: Base/delivered SHA and branch; Changed components; API/events/variants; Usage/composition/misuses; Checks and rendered evidence; Independent reviews; Integration instructions; Limitations.
Also <outputDir>/result.json: jobId, baseCommit, deliveredCommit, branch, taskOutcome, verification, reportPaths, checks, blockingFindings, limitations.
Keep authoritative knowledge in the product repository. Retain worktree and all work until host handoff acknowledgement; on failure/cancellation checkpoint changes/evidence and let the host stop processes and apply approved retention/cleanup.
All procedure rules are advisory; host-enforced permissions govern external actions.
