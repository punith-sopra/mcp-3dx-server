# Use a lightweight Node.js image
FROM node:18-slim

# Set the working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy the server code and the specs folder
COPY server.js ./
COPY specs/ ./specs/

# App Runner uses the PORT environment variable
ENV PORT=3000
EXPOSE 3000

# Start the server
CMD ["npm", "start"]
