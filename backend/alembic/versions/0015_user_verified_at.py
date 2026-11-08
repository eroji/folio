"""users.verified_at: when the directory last confirmed the account is active.

Sessions are long-lived; the API re-checks the account against LDAP once this
is older than ACCOUNT_CHECK_INTERVAL and ends every session of an account that
was disabled, locked out, removed or dropped from the Folio groups.

Revision ID: 0015
Revises: 0014
Create Date: 2026-11-08
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("verified_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "verified_at")
