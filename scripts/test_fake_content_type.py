#!/usr/bin/env python3
"""
测试：使用伪装的 content-type 绕过 Notion API 的格式限制

测试步骤：
1. 创建一个 .eml 测试文件
2. 尝试用真实 content-type (message/rfc822) 上传 → 预期失败
3. 尝试用伪装的 content-type (application/pdf) 上传 → 预期成功
"""

import asyncio
import sys
from pathlib import Path

# 添加项目根目录到 path
sys.path.insert(0, str(Path(__file__).parent.parent))

from src.config import config
from loguru import logger
import aiohttp


async def upload_file_with_content_type(
    file_path: str,
    content_type: str,
    step1_filename: str = None,
    step2_filename: str = None
) -> tuple[bool, str]:
    """
    使用指定的 content-type 和可选的伪装文件名上传文件

    Args:
        file_path: 实际文件路径
        content_type: 声明的 content-type
        step1_filename: Step 1 声明的文件名（用于绕过扩展名检查）
        step2_filename: Step 2 实际上传时的文件名（最终在 Notion 显示的名称）

    Returns:
        (success, file_upload_id or error_message)
    """
    file = Path(file_path)

    if not file.exists():
        return False, f"File not found: {file_path}"

    # Step 1 用伪装文件名，Step 2 用真实文件名（或指定的）
    declare_filename = step1_filename or file.name
    actual_filename = step2_filename or file.name

    notion_headers = {
        "Authorization": f"Bearer {config.notion_token}",
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json"
    }

    async with aiohttp.ClientSession() as session:
        # Step 1: Create file upload object (使用伪装文件名绕过检查)
        create_payload = {"filename": declare_filename}

        async with session.post(
            "https://api.notion.com/v1/file_uploads",
            headers=notion_headers,
            json=create_payload
        ) as resp:
            if resp.status != 200:
                error = await resp.text()
                return False, f"Step 1 failed: {error}"

            upload_obj = await resp.json()
            upload_url = upload_obj["upload_url"]
            file_upload_id = upload_obj["id"]

        # Step 2: Upload file content with specified content-type
        with open(file, 'rb') as f:
            file_content = f.read()

        send_headers = {
            "Authorization": f"Bearer {config.notion_token}",
            "Notion-Version": "2022-06-28"
        }

        form_data = aiohttp.FormData()
        form_data.add_field(
            'file',
            file_content,
            filename=actual_filename,  # Step 2 用真实文件名
            content_type=content_type  # 使用指定的 content-type
        )

        async with session.post(
            upload_url,
            headers=send_headers,
            data=form_data
        ) as resp:
            if resp.status not in [200, 201, 204]:
                error = await resp.text()
                return False, f"Step 2 failed ({resp.status}): {error}"

            return True, file_upload_id


async def main():
    # 创建测试 .eml 文件
    test_dir = Path("/tmp/test_notion_upload")
    test_dir.mkdir(exist_ok=True)

    test_eml = test_dir / "test_email.eml"
    test_eml.write_text("""From: test@example.com
To: recipient@example.com
Subject: Test Email
Date: Mon, 1 Jan 2026 10:00:00 +0800

This is a test email content.
""")

    logger.info(f"Created test file: {test_eml}")

    # 测试 1: 使用真实文件名 (预期失败)
    logger.info("\n=== Test 1: Real filename test_email.eml ===")
    success, result = await upload_file_with_content_type(
        str(test_eml),
        "message/rfc822"
    )
    if success:
        logger.success(f"Upload succeeded! file_upload_id: {result}")
    else:
        logger.warning(f"Upload failed (expected): {result[:100]}...")

    # 测试 2: Step1 伪装 .pdf，Step2 保持 .eml（核心测试）
    logger.info("\n=== Test 2: Step1=.pdf, Step2=.eml (KEY TEST!) ===")
    success, result = await upload_file_with_content_type(
        str(test_eml),
        "application/pdf",
        step1_filename="test_email.pdf",  # Step 1 绕过检查
        step2_filename="test_email.eml"   # Step 2 保持原扩展名
    )
    if success:
        logger.success(f"Upload succeeded! file_upload_id: {result}")
        logger.info(">>> Step1 fake + Step2 real extension WORKS!")
    else:
        logger.error(f"Upload failed: {result}")

    # 测试 3: 对比 - 两步都用 .pdf（之前验证过可行）
    logger.info("\n=== Test 3: Both steps use .pdf (baseline) ===")
    success, result = await upload_file_with_content_type(
        str(test_eml),
        "application/pdf",
        step1_filename="test_email.pdf",
        step2_filename="test_email.pdf"
    )
    if success:
        logger.success(f"Upload succeeded! file_upload_id: {result}")
    else:
        logger.error(f"Upload failed: {result}")

    # 测试 4: .xyz 文件 - Step1 伪装，Step2 保持原扩展名
    test_xyz = test_dir / "test_file.xyz"
    test_xyz.write_text("This is a test file with unsupported extension")

    logger.info("\n=== Test 4: .xyz file - Step1=.pdf, Step2=.xyz ===")
    success, result = await upload_file_with_content_type(
        str(test_xyz),
        "application/pdf",
        step1_filename="test_file.pdf",
        step2_filename="test_file.xyz"  # 保持原扩展名
    )
    if success:
        logger.success(f"Upload succeeded! file_upload_id: {result}")
    else:
        logger.error(f"Upload failed: {result}")

    # 清理
    test_eml.unlink(missing_ok=True)
    test_xyz.unlink(missing_ok=True)
    test_dir.rmdir()

    logger.info("\n=== Test completed ===")


if __name__ == "__main__":
    asyncio.run(main())
