import SteamCommunity from "steamcommunity";
import { getAllItemNames, fetchPrice } from "./utils/apiUtils";
import { loadPrices, loadState, saveState, createDirectories, savePrices } from "./utils/fileUtils";
import { getWeightedAveragePrice } from "./utils/priceUtils";
import * as fsPromises from "fs/promises";
import * as colors from 'colors';

const dir = `./static`;
const dirPrices = `./static/prices`;
const maxDuration = 3600 * 1000 * 5.7;
const startTime = Date.now();

export class SteamMarketFetcher {
    private community = new SteamCommunity();
    private priceDataByItemHashName: { [key: string]: any } = {};
    private failedItems: string[] = [];

    constructor(private accountName: string, private password: string) { }

    private async loginWithRetry(maxRetries: number = 3, retryDelay: number = 10000): Promise<void> {
        let lastError: Error | null = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                await new Promise<void>((resolve, reject) => {
                    this.community.login(
                        {
                            accountName: this.accountName,
                            password: this.password,
                            disableMobile: true,
                        },
                        (err: Error | null) => {
                            if (err) {
                                reject(err);
                            } else {
                                resolve();
                            }
                        }
                    );
                });
                console.log(colors.green("✅ Successfully logged into Steam community!"));
                return; // Success
            } catch (error) {
                lastError = error as Error;
                
                if (attempt < maxRetries) {
                    console.log(colors.yellow(`Login attempt ${attempt + 1}/${maxRetries} failed. Retrying in ${retryDelay}ms...`));
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                }
            }
        }

        throw new Error(`Failed to login after ${maxRetries} attempts: ${lastError?.message}`);
    }

    async run() {
        createDirectories([dir, dirPrices]);
        console.log(colors.magenta.italic("🔑 Logging into Steam community..."));

        try {
            await this.loginWithRetry();
            await this.processMarketData();
        } catch (error) {
            console.log(colors.red("Failed to login: " + error));
        }
    }

    private async processMarketData() {
        try {
            console.log(colors.magenta.italic("⏳ Loading items..."));
            const items = await getAllItemNames();
            
            if (items.length === 0) {
                console.error(colors.red("❌ Error: No items loaded. Aborting process."));
                return;
            }
            
            console.log(colors.magenta.bold(`📦 Processing ${items.length} items.`));
            const state = loadState();
            const lastIndex = (state.lastIndex || 0) % items.length;
            await this.processItems(items.slice(lastIndex), lastIndex);

            // Retry failed items once more
            if (this.failedItems.length > 0) {
                console.log(colors.yellow(`🔄 Retrying ${this.failedItems.length} failed items...`));
                const itemsToRetry = [...this.failedItems];
                this.failedItems = []; // Reset failed items before retry
                
                for (const item of itemsToRetry) {
                    await this.processBatch([item]);
                }
            }

            const prices = await loadPrices();
            const newPrices = {
                ...prices,
                ...this.priceDataByItemHashName,
            };
            const orderedNewPrices = Object.keys(newPrices)
                .sort()
                .reduce((acc: any, key) => {
                    acc[key] = newPrices[key];
                    return acc;
                }, {});

            await fsPromises.writeFile(
                `${dirPrices}/latest.json`,
                JSON.stringify(orderedNewPrices, null, 4)
            );

            savePrices(orderedNewPrices);

            // Log final statistics
            const successCount = Object.keys(this.priceDataByItemHashName).length;
            const failureCount = this.failedItems.length;
            console.log(colors.green(`✅ Successfully processed ${successCount} items`));
            if (failureCount > 0) {
                console.log(colors.red(`❌ Failed to process ${failureCount} items`));
            }

        } catch (error) {
            console.error("❌ An error occurred while processing items:", error);
        }
    }

    private async processBatch(batch: string[]) {
        const promises = batch.map(name =>
            fetchPrice(this.community, name)
                .then(async prices => {
                    if (prices.length > 0) {
                        this.priceDataByItemHashName[name] = {
                            steam: getWeightedAveragePrice(prices),
                        };
                    } else {
                        // Track items that return empty prices
                        if (!this.failedItems.includes(name)) {
                            this.failedItems.push(name);
                        }
                    }
                })
                .catch(error => {
                    console.log(`Error processing ${name}:`, error);
                    // Track items that throw errors
                    if (!this.failedItems.includes(name)) {
                        this.failedItems.push(name);
                    }
                })
        );
        await Promise.all(promises);
    }

    private async processItems(items: string[], startIndex: number, batchSize = 1) {
        const requestsPerMinute = 20;
        const delayPerBatch = (60 / requestsPerMinute) * batchSize * 1000;

        for (let i = 0; i < items.length; i += batchSize) {
            const currentTime = Date.now();
            if (currentTime - startTime >= maxDuration) {
                console.log(colors.green("⏰ Max duration reached. Stopping the process."));
                saveState({ lastIndex: startIndex + i });
                return;
            }

            const batch = items.slice(i, i + batchSize);
            await this.processBatch(batch);

            console.log(colors.blue(`☑️ Processed batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(items.length / batchSize)}`));

            saveState({ lastIndex: startIndex + i + batchSize });

            if (i + batchSize < items.length) {
                console.log(colors.cyan(`⌛ Waiting for ${delayPerBatch / 1000} seconds to respect rate limit...`));
                await new Promise(resolve => setTimeout(resolve, delayPerBatch));
            }
        }
    }
}
