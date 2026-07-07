UPDATE "cost_centers"
SET "manager" = 'Alice Smith'
WHERE "id" = 'CC-9001'
  AND "manager" = 'Dana White';

UPDATE "cost_centers"
SET "manager" = 'John Miller'
WHERE "id" = 'CC-9002'
  AND "manager" = 'Erik Stone';
