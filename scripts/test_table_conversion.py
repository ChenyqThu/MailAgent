"""测试HTML表格转换为Notion table block"""
import sys
from pathlib import Path
import json

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.converter.html_converter import HTMLToNotionConverter

def main():
    converter = HTMLToNotionConverter()

    # 测试HTML表格
    test_html = """
    <html>
    <body>
        <h2>示例表格</h2>
        <table>
            <tr>
                <th>事业部</th>
                <th>PLM</th>
                <th>一级分类</th>
                <th>二级分类</th>
            </tr>
            <tr>
                <td>Enterprise Networking</td>
                <td>Gary</td>
                <td>Gateway & Hardware Controller</td>
                <td>Business Gateway</td>
            </tr>
            <tr>
                <td>Enterprise Networking</td>
                <td>Penry</td>
                <td>Managed Switch</td>
                <td>L3 Managed Switch</td>
            </tr>
            <tr>
                <td>Enterprise Networking</td>
                <td>Neil</td>
                <td>Unmanaged and Easy Smart Switch</td>
                <td>Easy Smart Switch</td>
            </tr>
        </table>
        <p>表格后面的段落</p>
    </body>
    </html>
    """

    print("=" * 80)
    print("测试HTML表格转换")
    print("=" * 80)

    blocks = converter.convert(test_html)

    print(f"\n生成了 {len(blocks)} 个blocks:\n")

    for i, block in enumerate(blocks, 1):
        print(f"Block {i}: {block['type']}")

        if block['type'] == 'table':
            table_info = block['table']
            print(f"  - 宽度: {table_info['table_width']} 列")
            print(f"  - 包含表头: {table_info['has_column_header']}")
            print(f"  - 行数: {len(table_info['children'])}")

            # 打印前2行
            print(f"  - 前2行内容:")
            for j, row in enumerate(table_info['children'][:2], 1):
                cells = row['table_row']['cells']
                cell_values = [cell[0]['text']['content'] for cell in cells]
                print(f"    Row {j}: {cell_values}")

    print("\n" + "=" * 80)
    print("完整JSON输出（保存到 test_table_output.json）:")
    print("=" * 80)

    output_file = Path(__file__).parent / "test_table_output.json"
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(blocks, f, ensure_ascii=False, indent=2)

    print(f"✓ 已保存到: {output_file}")

if __name__ == "__main__":
    main()
