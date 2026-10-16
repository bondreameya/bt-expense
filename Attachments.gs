/**
 * Invoice/receipt attachments in Drive (scope: drive.file — the app can only see files/folders it created).
 * Layout: <root 'BT Expense Attachments'>/<CENTER_CODE>/<FY>/file. Root ID kept in Script Property ATTACHMENTS_ROOT_ID.
 */
var MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
var ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'];

function attachmentsRoot_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('ATTACHMENTS_ROOT_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { console.warn('Attachment root missing; recreating.'); } }
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    id = props.getProperty('ATTACHMENTS_ROOT_ID');
    if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
    var f = DriveApp.createFolder('BT Expense Attachments');
    props.setProperty('ATTACHMENTS_ROOT_ID', f.getId());
    return f;
  } finally { lock.releaseLock(); }
}

function subFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/** Upload from the client. Returns {file_id, name}. Store file_id on the record via create/update. */
function uploadAttachment(token, centerId, dateStr, file) {
  var sess = requireSession(token);
  assertCenter_(sess, centerId);
  D(dateStr);
  if (!file || !file.base64) throw new Error('No file received.');
  if (ALLOWED_MIME.indexOf(file.mimeType) < 0) throw new Error('Only PDF or image files can be attached.');
  var bytes = Utilities.base64Decode(file.base64);
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error('File is larger than 10 MB.');
  var center = centerById_(centerId);
  var folder = subFolder_(subFolder_(attachmentsRoot_(), center.center_code), finYear_(dateStr));
  var safeName = String(file.name || 'attachment').replace(/[^\w.\- ]+/g, '_').slice(0, 100);
  var f = folder.createFile(Utilities.newBlob(bytes, file.mimeType, safeName));
  f.setDescription('Uploaded by ' + sess.user_id + ' for ' + center.center_code);
  return { file_id: f.getId(), name: safeName };
}

/** The file must be one the app created inside its attachments root. */
function assertAttachmentOk_(fileId) {
  var f;
  try { f = DriveApp.getFileById(fileId); } catch (e) { throw new Error('Attachment not found. Please upload it again.'); }
  var rootId = attachmentsRoot_().getId();
  var p = f.getParents();
  while (p.hasNext()) {
    var fy = p.next(), c = fy.getParents();
    while (c.hasNext()) { var cc = c.next().getParents(); while (cc.hasNext()) if (cc.next().getId() === rootId) return true; }
  }
  throw new Error('Invalid attachment.');
}

/** Download an attachment of a record the caller can see (files are owned by the app owner, so stream them). */
function getAttachment(token, entity, recordId) {
  var sess = requireSession(token);
  var e = ent_(entity);
  if (!e.hasFile) throw new Error('No attachments for this record type.');
  var r = getRecord_(sess, e, recordId);
  var fileId = r.file_id;
  var pe = r.sys_remarks.pending_edit;
  if (!fileId) throw new Error('No attachment on this record.');
  var blob = DriveApp.getFileById(fileId).getBlob();
  return { name: blob.getName(), mimeType: blob.getContentType(), base64: Utilities.base64Encode(blob.getBytes()) };
}

/** Admin: preview the attachment proposed in a pending edit. */
function getPendingAttachment(token, entity, recordId) {
  var sess = requireSession(token, { admin: true });
  var r = getRecord_(sess, ent_(entity), recordId);
  var pe = r.sys_remarks.pending_edit;
  if (!pe || !pe.changes || !pe.changes.file_id) throw new Error('No proposed attachment.');
  assertAttachmentOk_(pe.changes.file_id);
  var blob = DriveApp.getFileById(pe.changes.file_id).getBlob();
  return { name: blob.getName(), mimeType: blob.getContentType(), base64: Utilities.base64Encode(blob.getBytes()) };
}
