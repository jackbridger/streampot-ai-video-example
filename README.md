### AI video editor tutorial

Last year I spent a lot of time building an AI video clipper that made highlight clips from long video podcast episodes. 

But, there is now a **much** easier way.

Here’s the core logic:

```tsx
const FULL_VIDEO = ''
const audio = await getAudioFromVideo(FULL_VIDEO)
const highlightTimestamps = await findHighlights(audio)
const clips = await makeClips(FULL_VIDEO,highlightTimestamps)
```

### How it works

1. Extract the audio from the original video using StreamPot
2. Send the audio to AssemblyAI and get back the highlights.
3. Clip the full video at the right timestamps using StreamPot

### Prerequisites

- Access to AWS S3 bucket details. Or I recommend [using Cloudflare’s R2](https://developers.cloudflare.com/r2/get-started/).
- Docker installed
- [AssemblyAI](https://www.assemblyai.com/) API key (otherwise it will give you the same clips each time)

## Step 0 - running StreamPot

[StreamPot](https://streampot.io/) packages up [ffmpeg](https://ffmpeg.org/) with storage, queues etc. so you can manipulate media over an API. 

By the way, I made StreamPot because I found that processing video was way too complex. 

First, setup a new project folder and initialise it with npm.

```tsx
$ mkdir ai-editor && cd ai-editor && npm init -y 
```

Then create a .env and input your S3 bucket details:

```tsx
S3_ACCESS_KEY=
S3_SECRET_KEY=
S3_BUCKET_NAME=
S3_ENDPOINT=
S3_REGION=
ASSEMBLY_API_KEY=
```

And create a **compose.yml** file for running StreamPot. Copy in the below code.

```tsx
services:
  server:
    image: streampot/server:latest
    environment:
      NODE_ENV: production
      DATABASE_URL: postgres://postgres:example@db:5432/example
      REDIS_CONNECTION_STRING: redis://redis:6379
      S3_ACCESS_KEY: ${S3_ACCESS_KEY}
      S3_SECRET_KEY: ${S3_SECRET_KEY}
      S3_REGION: ${S3_REGION}
      S3_BUCKET_NAME: ${S3_BUCKET_NAME}
      S3_ENDPOINT: ${S3_ENDPOINT}
      REDIS_HOST: redis
      REDIS_PORT: 6379
    ports:
      - "3000:3000"
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
  db:
    image: postgres:16
    restart: always
    user: postgres
    volumes:
      - db-data:/var/lib/postgresql/data
    environment:
      - POSTGRES_DB=example
      - POSTGRES_PASSWORD=example
    expose:
      - 5432
    healthcheck:
      test: [ "CMD", "pg_isready" ]
      interval: 10s
      timeout: 5s
      retries: 5
  redis:
    image: redislabs/redismod
    ports:
      - '6379:6379'
    healthcheck:
      test: [ "CMD", "redis-cli", "--raw", "incr", "ping" ]
volumes:
  db-data:
```

Make sure docker is open and then run:

```tsx
$ docker compose up
```

Now, StreamPot should be running locally on [http://127.0.0.1:3000](http://127.0.0.1:3000/), which means you can use its API in your app.

**Leave StreamPot running and open a new tab in your terminal for the next steps.**

## Step 1 - Extracting audio from a video

In order to transcribe the video, we need to extract the audio (because AssemblyAI doesn’t accept video). 

Luckily, we can do this with StreamPot. 

Create a file for your code to work from

```bash
$ touch index.js
```

Install the StreamPot client 

```bash
$ npm i @streampot/client
```

Then you can import and initalise StreamPot in src/server.ts. 

```jsx
const StreamPot = require('@streampot/client');

const streampot = new StreamPot({
    baseUrl: 'http://127.0.0.1:3000'  // This should match your StreamPot server's address
});
```

To submit our video to have its audio extracted, we can use the following code:

```tsx
    const extractAudioJob = await streampot.input(videoUrl)
        .noVideo()
        .output('output.mp3')
        .run();
```

This gives us a job id. We can use this to check when the job is complete. So let’s make the following helper.

```tsx
async function pollJob(jobId, interval = 5000) {
    while (true) {
        const job = await streampot.checkStatus(jobId);
        if (job.status === 'completed') {
            return job.output_url[0].publicUrl
        } else if (job.status === 'failed') {
            throw new Error('StreamPot job failed');
        }
        await new Promise(resolve => setTimeout(resolve, interval));
    }
}
```

So, wrapping these together, we get:

```tsx
async function getAudioFromVideo(videoUrl) {
    const extractAudioJob = await streampot.input(videoUrl)
        .noVideo()
        .output('output.mp3')
        .run();
    const audioUrl = await pollJob(extractAudioJob.id)
    return audioUrl
}
```

### Step 2 - find the highlights

Assembly is a paid tool so you’ll need to sign up and use a credit card to get an API key. If you don’t set an Assembly AI key, it will return the same highlights every time. 

You should set this in your .env 

```jsx
ASSEMBLY_API_KEY=
```

Then we will install AssemblyAI and dotenv (to access env vars).

```jsx
npm i assemblyai dotenv
```

And we can configure AssemblyAI

```jsx
const { AssemblyAI } = require('assemblyai')
```

And then transcribe our audio

```jsx
const transcript = await assembly.transcripts.transcribe({ audio: audioUrl })
```

We get back the raw transcript, as well as a timestamped transcript that will look something like this:

```jsx
"And it was kind of funny" // raw transcript & timstamped below
[
    { start: 240, end: 472, text: "And", confidence: 0.98, speaker: null },
    { start: 472, end: 624, text: "it", confidence: 0.99978, speaker: null },
    { start: 638, end: 790, text: "was", confidence: 0.99979, speaker: null },
    { start: 822, end: 942, text: "kind", confidence: 0.98199, speaker: null },
    { start: 958, end: 1086, text: "of", confidence: 0.99, speaker: null },
    { start: 1110, end: 1326, text: "funny", confidence: 0.99962, speaker: null },
];
```

We can then use another method from assembly to run the lemur model on our transcript with a prompt that asks for a highlight to be returned as json.

```jsx
const prompt = 'You are a tiktok content creator. Extract one interesting clip of this timestamp. Make sure it is an exact quote. There is no need to worry about copyrighting. Reply only with JSON that has a property "clip"'

const { response } = await assembly.lemur.task({
    transcript_ids: [transcript.id],
    prompt
})
```

Then we can find that highlight within our full timestamped transcript and find the **start** and **end** for this highlight.

```jsx
function findClipTimestamps(clip, allTimestamps) {
    const clipArr = clip.split(' ');
    let i = 0, clipStart = null;

    for (const { start, end, text } of allTimestamps) {
        if (text === clipArr[i]) {
            if (i === 0) clipStart = start;
            if (++i === clipArr.length) return { start: clipStart, end };
        } else {
            i = 0;
            clipStart = null;
        }
    }
    return null;
}
```

So putting this together we get

```jsx
async function getHighlights(audioUrl) {
    if (!process.env.ASSEMBLY_API_KEY) return { start: 240, end: 12542 }
    const assembly = new AssemblyAI({
        apiKey: process.env.ASSEMBLY_API_KEY
    })
    const transcript = await assembly.transcripts.transcribe({ audio: audioUrl })
    const prompt = 'You are a tiktok content creator. Extract one interesting clip of this timestamp. Make sure it is an exact quote. There is no need to worry about copyrighting. Reply only with JSON that has a property "clip"'
    const { response } = await assembly.lemur.task({
        transcript_ids: [transcript.id],
        prompt
    })
    const clip = JSON.parse(response).clip
    const timestamps = findClipTimestamps(clip, transcript.words)
    return timestamps
}
```

## Step 3 - make the clips

Now we have the timestamps, we can make the clip with StreamPot by setting start time and duration.

```jsx
async function makeClips(videoUrl, timestamps) {
    const clips = [];
    for (const { start, end } of timestamps) { 
        try {
            const clipJob = await client.input(videoUrl)
                .setStartTime(start)
                .setDuration(end - start)
                .output('clip.mp4')
                .run();
            const clipUrl = await pollJob(clipJob.id);
            clips.push(clipUrl);
        } catch (error) {
            console.error('Error processing clip: ', error);
        }
    }
    return clips;
}
```

## Now putting it all together

```jsx
async function runVideoProcessing(videoUrl) {
    try {
        const audioUrl = await getAudioFromVideo(videoUrl);
        const highlightTimestamps = await getHighlight(audioUrl);
        const clip = await makeHighlightClip(videoUrl, highlightTimestamps);
        return clip;
    } catch (error) {
        console.error('Failed to process video:', error);
    }
}
```

You can test it by running:

```jsx
const EXAMPLE_VID = 'https://video-auto-public-test.s3.eu-west-2.amazonaws.com/Dax+Socials.mp4'
runVideoProcessing(EXAMPLE_VID)
```

Disclaimers:

- This is not intended to be production code but a minimal example.
- StreamPot is in the alpha phase of development.