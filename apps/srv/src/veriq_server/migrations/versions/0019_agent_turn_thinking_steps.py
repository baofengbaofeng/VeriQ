"""为对话轮次补充思考（reasoning）全文与工具调用步骤，供流式回放与事后回看；既有轮次保留为空，不影响既有读取。"""

from alembic import op
import sqlalchemy as sa

revision = "0019_agent_turn_thinking_steps"
down_revision = "0018_user_created_at"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """新增可空 thinking 与 steps 两列；思考正文仅用于展示与审计，步骤用于渲染工具调用卡片，均不参与认证与授权。"""
    op.add_column("veriq_agent_turns", sa.Column("thinking", sa.Text))
    op.add_column("veriq_agent_turns", sa.Column("steps", sa.JSON))


def downgrade() -> None:
    """回退时从对话轮次表依次删除 steps 和 thinking，已保存的工具步骤和思考正文也随这两列删除。"""
    op.drop_column("veriq_agent_turns", "steps")
    op.drop_column("veriq_agent_turns", "thinking")
