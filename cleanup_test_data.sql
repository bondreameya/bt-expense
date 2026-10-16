-- Removes ALL end-to-end test data. Never touches ameyabondre or the 16 real centers.
-- Test users: test_admin, test_user, test_idem (sys_remarks.test=true) + mytestuser (USR-EB75C4A2D5, created manually while testing).
DECLARE tst STRING DEFAULT (SELECT center_id FROM `btdata.expenses.centers` WHERE center_code = 'TST' AND JSON_VALUE(sys_remarks, '$.test') = 'true');
DECLARE test_users ARRAY<STRING> DEFAULT (
  SELECT ARRAY_AGG(user_id) FROM `btdata.expenses.users`
  WHERE ((username IN ('test_admin', 'test_user', 'test_idem') AND JSON_VALUE(sys_remarks, '$.test') = 'true')
         OR (user_id = 'USR-EB75C4A2D5' AND username = 'mytestuser'))
    AND username != 'ameyabondre');
DECLARE test_vendors ARRAY<STRING> DEFAULT (SELECT ARRAY_AGG(vendor_id) FROM `btdata.expenses.vendors` WHERE name LIKE 'TEST %' AND JSON_VALUE(sys_remarks, '$.test') = 'true');
DECLARE test_cats ARRAY<STRING> DEFAULT (SELECT ARRAY_AGG(category_id) FROM `btdata.expenses.expense_categories` WHERE name LIKE 'TEST %' AND JSON_VALUE(sys_remarks, '$.test') = 'true');

DELETE FROM `btdata.expenses.expense_invoice_map` WHERE STARTS_WITH(expense_id, 'TST-') OR STARTS_WITH(invoice_id, 'TST-');
DELETE FROM `btdata.expenses.expense_receipt_map` WHERE STARTS_WITH(expense_id, 'TST-') OR STARTS_WITH(receipt_id, 'TST-');
DELETE FROM `btdata.expenses.expenses` WHERE center_id = tst;
DELETE FROM `btdata.expenses.invoices` WHERE center_id = tst;
DELETE FROM `btdata.expenses.receipts` WHERE center_id = tst;
DELETE FROM `btdata.expenses.id_counters` WHERE center_code = 'TST';
DELETE FROM `btdata.expenses.audit_log`
  WHERE JSON_VALUE(sys_remarks, '$.test') = 'true' OR changed_by IN UNNEST(test_users) OR record_id IN UNNEST(test_users)
     OR STARTS_WITH(record_id, 'TST-') OR record_id = tst OR record_id IN UNNEST(test_vendors) OR record_id IN UNNEST(test_cats);
DELETE FROM `btdata.expenses.login_log` WHERE username IN ('test_admin', 'test_user', 'test_idem', 'mytestuser') OR user_id IN UNNEST(test_users);
DELETE FROM `btdata.expenses.user_centers` WHERE user_id IN UNNEST(test_users) OR center_id = tst;
DELETE FROM `btdata.expenses.users` WHERE user_id IN UNNEST(test_users);
DELETE FROM `btdata.expenses.vendors` WHERE vendor_id IN UNNEST(test_vendors);
DELETE FROM `btdata.expenses.expense_categories` WHERE category_id IN UNNEST(test_cats);
DELETE FROM `btdata.expenses.centers` WHERE center_id = tst;
