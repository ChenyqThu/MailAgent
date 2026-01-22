from pathlib import Path
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email import encoders
from datetime import datetime
from typing import Optional

from loguru import logger
from src.models import Email

class EMLGenerator:
    """生成 .eml 文件"""

    @staticmethod
    def generate(email: Email, output_path: Optional[Path] = None) -> Path:
        """
        生成 .eml 文件

        Args:
            email: Email 对象
            output_path: 输出路径，如果为 None 则自动生成

        Returns:
            生成的 .eml 文件路径
        """
        try:
            # 创建 MIME 邮件
            msg = MIMEMultipart()
            msg["Subject"] = email.subject
            msg["From"] = f"{email.sender_name} <{email.sender}>"
            msg["To"] = email.to
            if email.cc:
                msg["Cc"] = email.cc
            msg["Date"] = email.date.strftime("%a, %d %b %Y %H:%M:%S %z")
            msg["Message-ID"] = email.message_id

            # 添加邮件正文
            if email.content_type == "text/html":
                msg.attach(MIMEText(email.content, "html", "utf-8"))
            else:
                msg.attach(MIMEText(email.content, "plain", "utf-8"))

            # 添加附件
            for attachment in email.attachments:
                try:
                    with open(attachment.path, "rb") as f:
                        part = MIMEBase("application", "octet-stream")
                        part.set_payload(f.read())
                        encoders.encode_base64(part)
                        part.add_header(
                            "Content-Disposition",
                            f"attachment; filename={attachment.filename}"
                        )
                        msg.attach(part)
                except Exception as e:
                    logger.error(f"Failed to attach file {attachment.filename}: {e}")

            # 确定输出路径
            if output_path is None:
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                safe_subject = "".join(c for c in email.subject if c.isalnum() or c in (" ", "-", "_"))[:50]
                filename = f"{timestamp}_{safe_subject}.eml"
                output_path = Path("/tmp") / filename

            # 写入文件
            with open(output_path, "w") as f:
                f.write(msg.as_string())

            logger.debug(f"Generated .eml file: {output_path}")
            return output_path

        except Exception as e:
            logger.error(f"Failed to generate .eml file: {e}")
            raise
