import mongoose from "mongoose";
import { logger } from "../utils/logger.js";

export const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        logger.info("MongoDB Connected Successfully");
    } catch (error) {
        logger.error({ err: error }, "Error while connecting to MongoDB");
        process.exit(1);
    }
};

