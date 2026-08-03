import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

public final class Phase6JavaSandboxProbe {
    private Phase6JavaSandboxProbe() {}

    private static boolean canRead(String value) {
        try {
            Files.readAllBytes(Path.of(value));
            return true;
        } catch (IOException | SecurityException denied) {
            return false;
        }
    }

    private static boolean canWrite(String value) {
        try {
            Files.writeString(
                Path.of(value),
                "sandbox-probe",
                StandardCharsets.UTF_8
            );
            return true;
        } catch (IOException | SecurityException denied) {
            return false;
        }
    }

    private static boolean canConnect(String host, int port) {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(host, port), 1_000);
            return true;
        } catch (IOException | SecurityException denied) {
            return false;
        }
    }

    private static boolean childProcessDenied(String javaExecutable) {
        try {
            Process process = new ProcessBuilder(javaExecutable, "-version").start();
            process.destroyForcibly();
            return false;
        } catch (IOException | SecurityException denied) {
            return true;
        }
    }

    public static void main(String[] args) {
        if (args.length != 6) {
            throw new IllegalArgumentException(
                "usage: SECRET SOURCE INSTALL_WRITE PRIVATE_WRITE LOOPBACK_PORT JAVA"
            );
        }
        boolean secretRead = canRead(args[0]);
        boolean sourceRead = canRead(args[1]);
        boolean installationWrite = canWrite(args[2]);
        boolean privateWrite = canWrite(args[3]);
        boolean loopbackDenied = !canConnect("127.0.0.1", Integer.parseInt(args[4]));
        boolean externalDenied = !canConnect("1.1.1.1", 53);
        boolean childProcessDenied = childProcessDenied(args[5]);
        System.out.printf(
            "{\"childProcessDenied\":%s,\"externalDenied\":%s," +
            "\"installationWrite\":%s,\"loopbackDenied\":%s," +
            "\"privateWrite\":%s,\"secretRead\":%s,\"sourceRead\":%s}%n",
            childProcessDenied,
            externalDenied,
            installationWrite,
            loopbackDenied,
            privateWrite,
            secretRead,
            sourceRead
        );
        System.out.flush();
    }
}
