import { SendMailClient } from "zeptomail";
import { config } from "../config.js";
import { logger } from "../logger.js";

// Initialize ZeptoMail client
const emailClient = new SendMailClient({
  url: config.email.url,
  token: config.email.token,
});

/**
 * Send welcome email to new user
 */
export async function sendWelcomeEmail(
  userEmail: string,
  userName?: string | null
): Promise<boolean> {
  try {
    if (!userEmail) {
      logger.warn("Cannot send welcome email: no email provided");
      return false;
    }

    const displayName = userName || "there";

    const htmlBody = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Welcome to Hydrilla</title>
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background-color: #ffffff; border-radius: 12px; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
            <div style="text-align: center; margin-bottom: 30px;">
              <h1 style="color: #000000; font-size: 28px; font-weight: 700; margin: 0 0 10px 0;">Welcome to Hydrilla!</h1>
            </div>
            
            <p style="font-size: 16px; color: #333; margin-bottom: 20px;">
              Hi ${displayName},
            </p>
            
            <p style="font-size: 16px; color: #333; margin-bottom: 20px;">
              We're thrilled to have you join Hydrilla! You can now create stunning 3D models from text prompts or images using AI.
            </p>
            
            <div style="background-color: #f5f5f5; border-radius: 8px; padding: 20px; margin: 30px 0;">
              <h2 style="color: #000000; font-size: 20px; margin-top: 0; margin-bottom: 15px;">What you can do:</h2>
              <ul style="color: #333; font-size: 15px; padding-left: 20px; margin: 0;">
                <li style="margin-bottom: 10px;">Generate 3D models from text descriptions</li>
                <li style="margin-bottom: 10px;">Convert images into 3D models</li>
                <li style="margin-bottom: 10px;">Download your creations as GLB files</li>
                <li style="margin-bottom: 0;">View and manage all your generations</li>
              </ul>
            </div>
            
            <div style="text-align: center; margin: 40px 0;">
              <a href="${config.email.frontendUrl}/generate" 
                 style="display: inline-block; background-color: #000000; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 16px;">
                Start Creating
              </a>
            </div>
            
            <p style="font-size: 14px; color: #666; margin-top: 40px; margin-bottom: 0;">
              If you have any questions, feel free to reach out to us at <a href="mailto:founders@hydrilla.co" style="color: #000000;">founders@hydrilla.co</a>
            </p>
            
            <p style="font-size: 14px; color: #666; margin-top: 20px; margin-bottom: 0;">
              Happy creating!<br>
              The Hydrilla Team
            </p>
          </div>
        </body>
      </html>
    `;

    const result = await emailClient.sendMail({
      from: {
        address: config.email.fromAddress,
        name: config.email.fromName,
      },
      to: [
        {
          email_address: {
            address: userEmail,
            name: userName || userEmail.split("@")[0] || "User",
          },
        },
      ],
      subject: "Welcome to Hydrilla! 🎉",
      htmlbody: htmlBody,
    });

    logger.info({ userEmail, userName }, "Welcome email sent successfully");
    return true;
  } catch (err: any) {
    logger.error(
      { err: err.message, stack: err.stack, userEmail },
      "Failed to send welcome email"
    );
    return false;
  }
}

/**
 * Send completion email when 3D model is ready
 */
export async function sendCompletionEmail(
  userEmail: string,
  userName: string | null,
  jobId: string,
  jobName: string | null,
  glbUrl: string,
  previewImageUrl: string | null
): Promise<boolean> {
  try {
    if (!userEmail) {
      logger.warn({ jobId }, "Cannot send completion email: no email provided");
      return false;
    }

    if (!glbUrl) {
      logger.warn({ jobId }, "Cannot send completion email: no GLB URL provided");
      return false;
    }

    const displayName = userName || "there";
    const modelName = jobName || "Your 3D Model";
    const viewerUrl = `${config.email.frontendUrl}/viewer?jobId=${jobId}`;
    const generateUrl = `${config.email.frontendUrl}/generate`;

    // Build preview image HTML if available
    const previewImageHtml = previewImageUrl
      ? `
        <div style="text-align: center; margin: 30px 0;">
          <img src="${previewImageUrl}" alt="Preview" style="max-width: 100%; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);" />
        </div>
      `
      : "";

    const htmlBody = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Your 3D Model is Ready!</title>
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background-color: #ffffff; border-radius: 12px; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
            <div style="text-align: center; margin-bottom: 30px;">
              <h1 style="color: #000000; font-size: 28px; font-weight: 700; margin: 0 0 10px 0;">Your 3D Model is Ready! 🎉</h1>
            </div>
            
            <p style="font-size: 16px; color: #333; margin-bottom: 20px;">
              Hi ${displayName},
            </p>
            
            <p style="font-size: 16px; color: #333; margin-bottom: 20px;">
              Great news! Your 3D model <strong>"${modelName}"</strong> has been generated successfully and is ready to view.
            </p>
            
            ${previewImageHtml}
            
            <div style="text-align: center; margin: 40px 0;">
              <a href="${viewerUrl}" 
                 style="display: inline-block; background-color: #000000; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 16px; margin-bottom: 12px;">
                View Your Model
              </a>
            </div>
            
            <div style="background-color: #f5f5f5; border-radius: 8px; padding: 20px; margin: 30px 0;">
              <h2 style="color: #000000; font-size: 18px; margin-top: 0; margin-bottom: 15px;">What's next?</h2>
              <ul style="color: #333; font-size: 15px; padding-left: 20px; margin: 0;">
                <li style="margin-bottom: 10px;">Click "View Your Model" to see it in 3D</li>
                <li style="margin-bottom: 10px;">Download the GLB file to use in your projects</li>
                <li style="margin-bottom: 0;">Create more models from the <a href="${generateUrl}" style="color: #000000; text-decoration: underline;">Generate page</a></li>
              </ul>
            </div>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${glbUrl}" 
                 style="display: inline-block; background-color: #f5f5f5; color: #000000; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 500; font-size: 14px; border: 1px solid #e0e0e0;">
                Download GLB File
              </a>
            </div>
            
            <p style="font-size: 14px; color: #666; margin-top: 40px; margin-bottom: 0;">
              If you have any questions, feel free to reach out to us at <a href="mailto:founders@hydrilla.co" style="color: #000000;">founders@hydrilla.co</a>
            </p>
            
            <p style="font-size: 14px; color: #666; margin-top: 20px; margin-bottom: 0;">
              Happy creating!<br>
              The Hydrilla Team
            </p>
          </div>
        </body>
      </html>
    `;

    await emailClient.sendMail({
      from: {
        address: config.email.fromAddress,
        name: config.email.fromName,
      },
      to: [
        {
          email_address: {
            address: userEmail,
            name: userName || userEmail.split("@")[0] || "User",
          },
        },
      ],
      subject: `Your 3D Model "${modelName}" is Ready! 🎉`,
      htmlbody: htmlBody,
    });

    logger.info({ userEmail, jobId, jobName }, "Completion email sent successfully");
    return true;
  } catch (err: any) {
    logger.error(
      { err: err.message, stack: err.stack, userEmail, jobId },
      "Failed to send completion email"
    );
    return false;
  }
}

/**
 * Get user email from database by userId
 */
export async function getUserEmail(userId: string | null): Promise<{ email: string | null; name: string | null } | null> {
  if (!userId) {
    return null;
  }

  try {
    const { supabase } = await import("../db.js");
    const { data, error } = await supabase
      .from("users")
      .select("email, first_name, last_name")
      .eq("id", userId)
      .single();

    if (error || !data) {
      logger.warn({ userId, error: error?.message }, "Could not fetch user email");
      return null;
    }

    const fullName = data.first_name || data.last_name
      ? `${data.first_name || ""} ${data.last_name || ""}`.trim()
      : null;

    return {
      email: data.email,
      name: fullName,
    };
  } catch (err: any) {
    logger.error({ err: err.message, userId }, "Failed to get user email");
    return null;
  }
}

/**
 * Send completion email for a job (helper function that fetches user info)
 */
export async function sendCompletionEmailForJob(
  jobId: string,
  userId: string | null,
  jobName: string | null,
  glbUrl: string,
  previewImageUrl: string | null
): Promise<boolean> {
  try {
    if (!userId) {
      logger.debug({ jobId }, "Job has no userId, skipping completion email");
      return false;
    }

    const userInfo = await getUserEmail(userId);
    if (!userInfo || !userInfo.email) {
      logger.warn({ jobId, userId }, "Could not get user email for completion email");
      return false;
    }

    return await sendCompletionEmail(
      userInfo.email,
      userInfo.name,
      jobId,
      jobName,
      glbUrl,
      previewImageUrl
    );
  } catch (err: any) {
    logger.error({ err: err.message, jobId }, "Failed to send completion email for job");
    return false;
  }
}

/**
 * Send GPU offline notification email to founders with retry logic
 */
export async function sendGpuOfflineNotification(
  userId: string | null,
  userEmail: string | null,
  errorMessage: string
): Promise<boolean> {
  const maxRetries = 3;
  const retryDelay = 2000; // 2 seconds

  const htmlBody = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>GPU Offline Notification</title>
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background-color: #ffffff; border-radius: 12px; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #dc2626; font-size: 24px; font-weight: 700; margin: 0 0 10px 0;">⚠️ GPU Offline Alert</h1>
          </div>
          
          <p style="font-size: 16px; color: #333; margin-bottom: 20px;">
            A user encountered a GPU offline error.
          </p>
          
          <div style="background-color: #fef2f2; border-left: 4px solid #dc2626; border-radius: 4px; padding: 16px; margin: 20px 0;">
            <p style="font-size: 14px; color: #991b1b; margin: 0; font-weight: 600;">Error Details:</p>
            <p style="font-size: 14px; color: #7f1d1d; margin: 8px 0 0 0;">${errorMessage.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
          </div>
          
          <div style="background-color: #f5f5f5; border-radius: 8px; padding: 20px; margin: 30px 0;">
            <h2 style="color: #000000; font-size: 18px; margin-top: 0; margin-bottom: 15px;">User Information:</h2>
            <ul style="color: #333; font-size: 14px; padding-left: 20px; margin: 0;">
              <li style="margin-bottom: 8px;"><strong>User ID:</strong> ${userId || 'Anonymous'}</li>
              <li style="margin-bottom: 8px;"><strong>User Email:</strong> ${userEmail || 'Not available'}</li>
              <li style="margin-bottom: 0;"><strong>Timestamp:</strong> ${new Date().toISOString()}</li>
            </ul>
          </div>
          
          <p style="font-size: 14px; color: #666; margin-top: 30px; margin-bottom: 0;">
            Please check the GPU instance and restart if necessary.
          </p>
        </div>
      </body>
    </html>
  `;

  // Retry logic with timeout wrapper
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Wrap email send in a timeout promise
      const emailPromise = emailClient.sendMail({
        from: {
          address: config.email.fromAddress,
          name: config.email.fromName,
        },
        to: [
          {
            email_address: {
              address: "founders@hydrilla.co",
              name: "Hydrilla Founders",
            },
          },
        ],
        subject: "🚨 GPU Offline Alert - Action Required",
        htmlbody: htmlBody,
      });

      // Add 30 second timeout for email sending
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Email send timeout after 30 seconds")), 30000);
      });

      await Promise.race([emailPromise, timeoutPromise]);

      logger.info({ userId, userEmail, attempt }, "GPU offline notification email sent to founders");
      return true;
    } catch (err: any) {
      const isTimeout = err.message?.includes("ETIMEDOUT") || 
                       err.message?.includes("timeout") ||
                       err.message?.includes("ECONNRESET") ||
                       err.message?.includes("ECONNREFUSED");
      
      if (attempt < maxRetries && isTimeout) {
        logger.warn(
          { err: err.message, userId, userEmail, attempt, maxRetries },
          `Failed to send GPU offline notification email (attempt ${attempt}/${maxRetries}), retrying in ${retryDelay * attempt}ms...`
        );
        // Wait before retrying with exponential backoff
        await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
        continue;
      }
      
      // Log detailed error for debugging
      logger.error(
        { 
          err: err.message, 
          stack: err.stack, 
          userId, 
          userEmail, 
          attempt,
          errorType: err.constructor?.name,
          code: err.code,
        },
        "Failed to send GPU offline notification email after retries"
      );
      
      // If all retries failed, still log that we tried (for monitoring)
      if (attempt === maxRetries) {
        logger.error(
          { userId, userEmail, errorMessage },
          "CRITICAL: GPU offline notification email failed after all retries. Manual intervention may be needed."
        );
      }
      
      return false;
    }
  }

  return false;
}

