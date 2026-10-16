-- Removes ALL end-to-end test data (center TST, users test_admin/test_user, TEST vendors/categories).
-- NOT executed automatically. Review, then run statement by statement in the BigQuery console.
DECLARE tst STRING DEFAULT (SELECT center_id FROM `btdata.expenses.centers` WHERE center_code = 'TST' AND JSON_VALUE(sys_remarks, '$.test') = 'true');
DECLARE test_users ARRAY<STRING> DEFAULT (SELECT ARRAY_AGG(user_id) FROM `btdata.expenses.users` WHERE username IN ('test_admin', 'test_user') AND JSON_VALUE(sys_remarks, '$.test') = 'true');

DELETE FROM `btdata.expenses.expense_invoice_map` WHERE STARTS_WITH(expense_id, 'TST-') AND JSON_VALUE(sys_remarks, '$.test') = 'true';
DELETE FROM `btdata.expenses.expense_receipt_map` WHERE STARTS_WITH(expense_id, 'TST-') AND JSON_VALUE(sys_remarks, '$.test') = 'true';
DELETE FROM `btdata.expenses.expenses` WHERE center_id = tst;
DELETE FROM `btdata.expenses.invoices` WHERE center_id = tst;
DELETE FROM `btdata.expenses.receipts` WHERE center_id = tst;
DELETE FROM `btdata.expenses.id_counters` WHERE center_code = 'TST';
DELETE FROM `btdata.expenses.audit_log` WHERE JSON_VALUE(sys_remarks, '$.test') = 'true' OR changed_by IN UNNEST(test_users) OR STARTS_WITH(record_id, 'TST-') OR record_id = tst;
DELETE FROM `btdata.expenses.login_log` WHERE username IN ('test_admin', 'test_user');
DELETE FROM `btdata.expenses.user_centers` WHERE user_id IN UNNEST(test_users) OR center_id = tst;
DELETE FROM `btdata.expenses.users` WHERE user_id IN UNNEST(test_users);
DELETE FROM `btdata.expenses.vendors` WHERE name LIKE 'TEST %' AND JSON_VALUE(sys_remarks, '$.test') = 'true';
DELETE FROM `btdata.expenses.expense_categories` WHERE name LIKE 'TEST %' AND JSON_VALUE(sys_remarks, '$.test') = 'true';
DELETE FROM `btdata.expenses.centers` WHERE center_id = tst;
