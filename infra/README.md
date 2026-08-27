# infra
```
aws dynamodb create-table --cli-input-json file://ledger-table.json          # after envsubst
aws dynamodb update-time-to-live --table-name ... --time-to-live-specification "Enabled=true,AttributeName=ttl"
aws dynamodb update-continuous-backups --table-name ... --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true
aws secretsmanager create-secret --name ess-ufm/intake/hmac-${ENVIRONMENT} --secret-string '{"current":"<64 hex>"}'
```
The task role needs dynamodb PutItem/GetItem/Query/UpdateItem/DescribeTable on the table and indexes, s3 PutObject on the audit prefix, secretsmanager GetSecretValue on the secret, and (sweeper only) s3 ListBucket/GetObject on the inventory bucket.
