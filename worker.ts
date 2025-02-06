import express, { Request, Response, NextFunction } from "express";
import { exec } from "child_process";
import Docker from "dockerode";
import cors from "cors";
import { promisify } from "util";
import dotenv from "dotenv";
import { Readable } from "stream";

dotenv.config();

const execAsync = promisify(exec);
const app = express();
const docker = new Docker();

// Types
interface DeploymentRequest {
  repository: string;
  branch: string;
  botId: string;
  deploymentId: string;
}

// Deployment status tracking
const deploymentStatus = new Map<string, string>();

// Authentication middleware
const authMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.WORKER_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
};

// Middleware
app.use(express.json());
app.use(cors());
app.use((req, res, next) => {
  const startTime = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - startTime;
    console.log(`${req.method} ${req.url} - ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// Health check endpoint
app.get("/health", authMiddleware, (req: Request, res: Response) => {
  res.json({ status: "ok", version: "1.0.0" });
});

async function sendLogsToSupabase(
  botId: string,
  message: string,
  level: "info" | "warning" | "error" = "info"
) {
  try {
    const response = await fetch(
      "supabaseurl/rest/v1/bot_logs",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey:
            "supabase anonkey",
          Authorization:
            "Bearer supabase anonkey",
        },
        body: JSON.stringify({
          bot_id: botId,
          message,
          level,
        }),
      }
    );

    if (!response.ok) {
      console.error("Failed to send logs to Supabase:", await response.text());
    }
  } catch (error) {
    console.error("Error sending logs to Supabase:", error);
  }
}

// Deploy endpoint
app.post(
  "/deploy",
  authMiddleware,
  async (req: Request<{}, {}, DeploymentRequest>, res: Response) => {
    const { repository, branch, botId, deploymentId } = req.body;
    let cleanupRequired = false;

    try {
      // Validate request body
      if (!repository || !branch || !botId || !deploymentId) {
        throw new Error("Missing required parameters");
      }

      deploymentStatus.set(deploymentId, "STARTED");

      // Clean up any existing files
      try {
        await execAsync(`rm -rf /tmp/${botId}`);
        cleanupRequired = true;
      } catch (cleanupError) {
        console.error("Cleanup error:", cleanupError);
        // Continue despite cleanup error
      }

      // Clone repository
      console.log(`Cloning repository: ${repository}`);
      try {
        await execAsync(`git clone -b ${branch} ${repository} /tmp/${botId}`, {
          timeout: 30000, // 30 second timeout
        });
      } catch (cloneError) {
        throw new Error(
          `Failed to clone repository: ${
            cloneError instanceof Error ? cloneError.message : "Unknown error"
          }`
        );
      }

      // Check if Dockerfile exists
      const { stdout: hasDockerfile } = await execAsync(
        `test -f /tmp/${botId}/Dockerfile && echo "yes" || echo "no"`
      );
      if (hasDockerfile.trim() !== "yes") {
        throw new Error("Dockerfile not found in repository");
      }

      // Stop and remove existing container if exists
      try {
        const container = docker.getContainer(`bot-${botId}`);
        await container.stop();
        await container.remove();
      } catch (error) {
        console.log("No existing container to remove");
      }

      // Build Docker image
      console.log("Building Docker image...");
      const imageTag = `botdeploy-${botId}:latest`;
      try {
        await new Promise((resolve, reject) => {
          docker.buildImage(
            {
              context: `/tmp/${botId}`,
              src: ["Dockerfile", "."],
            },
            { t: imageTag },
            function (err, stream) {
              if (err) {
                return reject(err);
              }
              if (!stream) {
                return reject(new Error("No stream returned from buildImage"));
              }

              docker.modem.followProgress(
                stream,
                (err: Error | null, output: any[]) => {
                  if (err) reject(err);
                  else resolve(output);
                },
                (event: { stream?: string }) => {
                  if (event.stream) {
                    console.log(event.stream.trim());
                  }
                }
              );
            }
          );
        });
      } catch (buildError) {
        throw new Error(
          `Docker build failed: ${
            buildError instanceof Error ? buildError.message : "Unknown error"
          }`
        );
      }

      // Create and start container
      console.log("Creating container...");
      const container = await docker.createContainer({
        Image: imageTag,
        name: `bot-${botId}-${Date.now()}`,
        HostConfig: {
          RestartPolicy: {
            Name: "unless-stopped",
          },
          Memory: 512 * 1024 * 1024, // 512MB memory limit
          MemorySwap: 1024 * 1024 * 1024, // 1GB swap
          CpuQuota: 100000, // 10% of CPU
          CpuPeriod: 100000,
          NetworkMode: "bridge", // Ensure network isolation
          SecurityOpt: ["no-new-privileges"], // Security enhancement
        },
        Env: [`BOT_ID=${botId}`, `DEPLOYMENT_ID=${deploymentId}`],
        StopTimeout: 10, // 10 seconds to gracefully stop
      });

      console.log("Starting container...");
      await container.start();

      // Verify container is running
      const containerInfo = await container.inspect();
      if (!containerInfo.State.Running) {
        throw new Error("Container failed to start");
      }

      deploymentStatus.set(deploymentId, "COMPLETED");

      res.json({
        success: true,
        deploymentId,
        imageId: imageTag,
        containerId: containerInfo.Id,
        status: "RUNNING",
        startedAt: containerInfo.State.StartedAt,
      });
    } catch (error) {
      console.error("Deployment error:", error);
      deploymentStatus.set(deploymentId, "FAILED");

      // Cleanup on error if needed
      if (cleanupRequired) {
        try {
          await execAsync(`rm -rf /tmp/${botId}`);
        } catch (cleanupError) {
          console.error("Cleanup error:", cleanupError);
        }
      }

      res.status(500).json({
        success: false,
        deploymentId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

// Status endpoint
app.get(
  "/status/:deploymentId",
  authMiddleware,
  (req: Request, res: Response): void => {
    const status = deploymentStatus.get(req.params.deploymentId) || "NOT_FOUND";
    res.json({ status });
  }
);

// Container logs endpoint with improved error handling and streaming
app.get(
  "/containers/:containerId/logs",
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { containerId } = req.params;
    const { tail = "100" } = req.query;

    try {
      // Validate container ID format
      if (!containerId.match(/^[a-zA-Z0-9]+$/)) {
        res.status(400).json(["Invalid container ID format"]);
        return;
      }

      // Get container instance
      const containers = await docker.listContainers();
      const container = containers.find((c) => c.Id.startsWith(containerId));

      if (!container) {
        res.status(404).json(["Container not found"]);
        return;
      }

      const dockerContainer = docker.getContainer(container.Id);

      // Get logs as buffer
      const logs = await dockerContainer.logs({
        stdout: true,
        stderr: true,
        tail: parseInt(tail as string, 10) || 100,
        follow: false,
      });

      // Process logs buffer
      if (Buffer.isBuffer(logs)) {
        const logLines = logs
          .toString("utf8")
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => {
            const timestamp = new Date().toISOString();
            return `[${timestamp}] ${line.trim()}`;
          });

        res.json(logLines.length > 0 ? logLines : ["No logs available"]);
      } else {
        res.json(["No logs available"]);
      }
    } catch (error) {
      console.error("Error fetching container logs:", error);
      res
        .status(500)
        .json([
          `Error fetching logs: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        ]);
    }
  }
);

app.get(
  "/logs/:containerId",
  authMiddleware,
  async (req: Request, res: Response) => {
    const { containerId } = req.params;

    console.log("Getting logs for container:", containerId);

    try {
      // Get container logs
      const { stdout } = await execAsync(
        `docker logs --tail 100 ${containerId} 2>&1`
      );

      console.log("Got logs, length:", stdout.length);

      res.json({ success: true, logs: stdout });
    } catch (error: any) {
      console.error("Error getting logs:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Worker service running on port ${PORT}`);
});
