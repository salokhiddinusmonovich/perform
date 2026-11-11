-- The platform admin's activity list (GET /platform/audit): newest first, or one person's entries.
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
CREATE INDEX "AuditLog_actorUserId_createdAt_idx" ON "AuditLog"("actorUserId", "createdAt");
CREATE INDEX "AuditLog_impersonatorUserId_idx" ON "AuditLog"("impersonatorUserId");
