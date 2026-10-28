// 生成 / 校验 DavMail token 加密的 golden 样本（只用假字符串，绝不碰真实 token）。
// 用法见同目录 regen.sh。
//
//   java -cp <davmail.jar>:<lib/*> GenGolden.java generate <out_dir>
//     → <out_dir>/golden.properties（各组参数下 Java 加密结果）
//     → <out_dir>/token.dat（Settings.storeRefreshToken 真实写出的 token 文件）
//   java -cp ... GenGolden.java verify <token_file> <username> <password> <expected_plaintext>
//     → 用 DavMail 自己的 loadRefreshToken + StringEncryptor 读回，打印 OK 或抛错

import davmail.Settings;
import davmail.util.StringEncryptor;

import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;

public class GenGolden {
    static final String PASSWORD = "golden-test-cipher-key";
    static final String CUSTOM_FINGERPRINT = "golden-salt-1234";
    // 两条明文的密文 base64 末尾都带 "="，顺带覆盖 Properties 的 `=` 转义
    static final String FAKE_SHORT = "FAKE-TOKEN-16BYT";
    static final String FAKE_LONG = "0.FAKE-REFRESH-TOKEN.mailagent-golden_sample~not-a-real-secret/AbCdEf+123=";
    static final String USERNAME = "Golden.User@Example.com";

    public static void main(String[] args) throws Exception {
        if (args[0].equals("generate")) {
            generate(Path.of(args[1]));
        } else if (args[0].equals("verify")) {
            verify(args[1], args[2], args[3], args[4]);
        } else {
            throw new IllegalArgumentException(args[0]);
        }
    }

    static void generate(Path out) throws Exception {
        Files.createDirectories(out);
        Properties p = new Properties();
        p.setProperty("password", PASSWORD);
        p.setProperty("custom_fingerprint", CUSTOM_FINGERPRINT);
        p.setProperty("username", USERNAME);
        p.setProperty("plain.short", FAKE_SHORT);
        p.setProperty("plain.long", FAKE_LONG);

        StringEncryptor enc = new StringEncryptor(PASSWORD);
        p.setProperty("default.short", enc.encryptString(FAKE_SHORT));
        p.setProperty("default.long", enc.encryptString(FAKE_LONG));

        Settings.setProperty("davmail.oauth.fingerprint", CUSTOM_FINGERPRINT);
        p.setProperty("custom.long", enc.encryptString(FAKE_LONG));
        Settings.setProperty("davmail.oauth.fingerprint", "davmailgateway!&");

        try (OutputStreamWriter w = new OutputStreamWriter(
                new FileOutputStream(out.resolve("golden.properties").toFile()), StandardCharsets.ISO_8859_1)) {
            p.store(w, "DavMail StringEncryptor golden samples (fake strings only), see regen.sh");
        }

        Path tokenFile = out.resolve("token.dat");
        Files.deleteIfExists(tokenFile);
        Settings.setProperty("davmail.oauth.tokenFilePath", tokenFile.toString());
        Settings.storeRefreshToken(USERNAME, enc.encryptString(FAKE_LONG));
        System.out.println("generated " + out);
    }

    static void verify(String tokenFile, String username, String password, String expected) throws Exception {
        Settings.setProperty("davmail.oauth.tokenFilePath", tokenFile);
        String stored = Settings.loadRefreshToken(username);
        if (stored == null) {
            throw new IllegalStateException("no token for " + username);
        }
        String plain = new StringEncryptor(password).decryptString(stored);
        if (!plain.equals(expected)) {
            throw new IllegalStateException("plaintext mismatch");
        }
        System.out.println("OK");
    }
}
