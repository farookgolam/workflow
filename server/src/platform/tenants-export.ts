// The global console's "Export to Excel": every customer on one sheet, with what the console knows about each -
// its address and status, people, forms, requests, the room its files take, and when it was last used.
// Counts and sizes only: nothing a customer's people wrote is read here.
import ExcelJS from 'exceljs';
import { unscopedQuery } from '../db/query';
import { tenantBaseUrl } from '../tenant';

interface Row {
  TenantId: number; Name: string; Slug: string; Host: string | null; IsActive: boolean; CreatedAt: Date; RemovedAt: Date | null; PurgeAfter: Date | null;
  FileStorageRoot: string | null; AdminNotifyEmail: string | null;
  People: number; Deactivated: number; NoKey: number; Admins: number; Approvers: number; AdminEmails: string | null;
  Forms: number; Requests: number; InProgress: number; Approved: number; Rejected: number; Cancelled: number;
  Pdfs: number; PdfBytes: number | string; Documents: number; DocumentBytes: number | string;
  Lookups: number; FailedEmails: number; LastActivityAt: Date | null; LastSignInAt: Date | null;
}

const SQL = `
  SELECT t.TenantId, t.Name, t.Slug, t.Host, t.IsActive, t.CreatedAt, t.RemovedAt, t.PurgeAfter, t.FileStorageRoot, t.AdminNotifyEmail,
         (SELECT COUNT(*) FROM Users u WHERE u.TenantId = t.TenantId AND u.IsActive = 1) AS People,
         (SELECT COUNT(*) FROM Users u WHERE u.TenantId = t.TenantId AND u.IsActive = 0) AS Deactivated,
         (SELECT COUNT(*) FROM Users u WHERE u.TenantId = t.TenantId AND u.IsActive = 1 AND u.PasswordSetAt IS NULL) AS NoKey,
         (SELECT COUNT(*) FROM UserRoles r JOIN Users u ON u.TenantId = r.TenantId AND u.UserId = r.UserId
           WHERE r.TenantId = t.TenantId AND r.Role = 'Admin' AND u.IsActive = 1) AS Admins,
         (SELECT COUNT(*) FROM UserRoles r JOIN Users u ON u.TenantId = r.TenantId AND u.UserId = r.UserId
           WHERE r.TenantId = t.TenantId AND r.Role = 'Approver' AND u.IsActive = 1) AS Approvers,
         (SELECT STRING_AGG(CAST(u.Email AS NVARCHAR(MAX)), '; ') WITHIN GROUP (ORDER BY u.Email)
            FROM UserRoles r JOIN Users u ON u.TenantId = r.TenantId AND u.UserId = r.UserId
           WHERE r.TenantId = t.TenantId AND r.Role = 'Admin' AND u.IsActive = 1) AS AdminEmails,
         (SELECT COUNT(*) FROM Forms f WHERE f.TenantId = t.TenantId AND f.IsActive = 1 AND f.DeletedAt IS NULL) AS Forms,
         (SELECT COUNT(*) FROM Requests q WHERE q.TenantId = t.TenantId) AS Requests,
         (SELECT COUNT(*) FROM Requests q WHERE q.TenantId = t.TenantId AND q.Status = 'InProgress') AS InProgress,
         (SELECT COUNT(*) FROM Requests q WHERE q.TenantId = t.TenantId AND q.Status = 'Approved') AS Approved,
         (SELECT COUNT(*) FROM Requests q WHERE q.TenantId = t.TenantId AND q.Status = 'Rejected') AS Rejected,
         (SELECT COUNT(*) FROM Requests q WHERE q.TenantId = t.TenantId AND q.Status = 'Cancelled') AS Cancelled,
         (SELECT COUNT(*) FROM RequestDocuments d WHERE d.TenantId = t.TenantId) AS Pdfs,
         (SELECT COALESCE(SUM(CAST(d.SizeBytes AS BIGINT)), 0) FROM RequestDocuments d WHERE d.TenantId = t.TenantId) AS PdfBytes,
         (SELECT COUNT(*) FROM StepAttachments s WHERE s.TenantId = t.TenantId) AS Documents,
         (SELECT COALESCE(SUM(CAST(s.SizeBytes AS BIGINT)), 0) FROM StepAttachments s WHERE s.TenantId = t.TenantId) AS DocumentBytes,
         (SELECT COUNT(*) FROM LookupTables l WHERE l.TenantId = t.TenantId) AS Lookups,
         (SELECT COUNT(*) FROM Notifications n WHERE n.TenantId = t.TenantId AND n.Status = 'Failed') AS FailedEmails,
         (SELECT MAX(a.OccurredAt) FROM AuditLog a WHERE a.TenantId = t.TenantId) AS LastActivityAt,
         (SELECT MAX(a.OccurredAt) FROM AuditLog a WHERE a.TenantId = t.TenantId AND a.Action = 'auth.login') AS LastSignInAt
    FROM Tenants t
   ORDER BY t.Name`;

const mb = (bytes: number | string) => Math.round((Number(bytes) / (1024 * 1024)) * 100) / 100;

/** The workbook as bytes, and how many customers are in it. */
export async function customersWorkbook(): Promise<{ file: Buffer; customers: number }> {
  const rows = await unscopedQuery<Row>(SQL);
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const ws = wb.addWorksheet('Customers', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });
  ws.columns = [
    { header: 'Customer', key: 'name', width: 30 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Address', key: 'slug', width: 18 },
    { header: 'Site', key: 'url', width: 42 },
    { header: 'Created (UTC)', key: 'created', width: 18, style: { numFmt: 'mm/dd/yyyy hh:mm' } },
    { header: 'People (active)', key: 'people', width: 15 },
    { header: 'Administrators', key: 'admins', width: 15 },
    { header: 'Administrator emails', key: 'adminEmails', width: 44 },
    { header: 'Approvers', key: 'approvers', width: 11 },
    { header: 'Not signed in yet', key: 'noKey', width: 16 },
    { header: 'Deactivated people', key: 'deactivated', width: 18 },
    { header: 'Active forms', key: 'forms', width: 13 },
    { header: 'Requests', key: 'requests', width: 10 },
    { header: 'In progress', key: 'inProgress', width: 12 },
    { header: 'Approved', key: 'approved', width: 10 },
    { header: 'Rejected', key: 'rejected', width: 10 },
    { header: 'Cancelled', key: 'cancelled', width: 10 },
    { header: 'Storage (MB)', key: 'storage', width: 13, style: { numFmt: '#,##0.00' } },
    { header: 'Final PDFs', key: 'pdfs', width: 11 },
    { header: 'Final PDFs (MB)', key: 'pdfMb', width: 15, style: { numFmt: '#,##0.00' } },
    { header: 'Approver documents', key: 'documents', width: 19 },
    { header: 'Approver documents (MB)', key: 'documentMb', width: 23, style: { numFmt: '#,##0.00' } },
    { header: 'New files are kept in', key: 'files', width: 40 },
    { header: 'Look-up lists', key: 'lookups', width: 13 },
    { header: 'Failed emails', key: 'failedEmails', width: 13 },
    { header: 'Last activity (UTC)', key: 'lastActivity', width: 18, style: { numFmt: 'mm/dd/yyyy hh:mm' } },
    { header: 'Last sign-in (UTC)', key: 'lastSignIn', width: 18, style: { numFmt: 'mm/dd/yyyy hh:mm' } },
    { header: 'Notification address', key: 'notify', width: 30 },
    { header: 'Removed on (UTC)', key: 'removed', width: 18, style: { numFmt: 'mm/dd/yyyy hh:mm' } },
    { header: 'Data deleted on (UTC)', key: 'purge', width: 18, style: { numFmt: 'mm/dd/yyyy hh:mm' } },
  ];
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    ws.addRow({
      name: r.Name,
      status: r.RemovedAt ? 'Removed' : r.IsActive ? 'Active' : 'Suspended',
      slug: r.Slug,
      url: tenantBaseUrl({ slug: r.Slug, host: r.Host }),
      created: r.CreatedAt,
      people: r.People, admins: r.Admins, adminEmails: r.AdminEmails ?? '', approvers: r.Approvers, noKey: r.NoKey, deactivated: r.Deactivated,
      forms: r.Forms, requests: r.Requests, inProgress: r.InProgress, approved: r.Approved, rejected: r.Rejected, cancelled: r.Cancelled,
      storage: mb(Number(r.PdfBytes) + Number(r.DocumentBytes)),
      pdfs: r.Pdfs, pdfMb: mb(r.PdfBytes), documents: r.Documents, documentMb: mb(r.DocumentBytes),
      files: r.FileStorageRoot ?? 'The database',
      lookups: r.Lookups, failedEmails: r.FailedEmails,
      lastActivity: r.LastActivityAt, lastSignIn: r.LastSignInAt,
      notify: r.AdminNotifyEmail ?? '',
      removed: r.RemovedAt, purge: r.PurgeAfter,
    });
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };
  return { file: Buffer.from(await wb.xlsx.writeBuffer()), customers: rows.length };
}
